import { BinanceService } from '../services/binance-service';
import { TradeHistoryService } from '../services/trade-history-service';
import { ProfitCalculator, ProfitAnalysis } from '../services/profit-calculator';
import { OrderHistoryManager } from '../services/order-history-manager';
import { logInfo, logWarn, logError } from '../utils/logger';
import { handleError } from '../utils/command-helpers';

export interface ProfitCommandOptions {
  since?: string;
  pair?: string;
  groupBy?: 'symbol' | 'all';
  format?: 'table' | 'json';
  refresh?: boolean;
  excludeUnrealized?: boolean;
  unrealizedOnly?: boolean;
}

export async function handleProfitCommand(options: ProfitCommandOptions): Promise<void> {
  try {
    // 验证环境变量
    const exchangeId = (process.env.TRADING_EXCHANGE || 'binance').toLowerCase();
    const apiKey =
      exchangeId === 'bybit'
        ? process.env.BYBIT_API_KEY || process.env.EXCHANGE_API_KEY
        : process.env.BINANCE_API_KEY || process.env.EXCHANGE_API_KEY;
    const apiSecret =
      exchangeId === 'bybit'
        ? process.env.BYBIT_API_SECRET || process.env.EXCHANGE_API_SECRET
        : process.env.BINANCE_API_SECRET || process.env.EXCHANGE_API_SECRET;

    if (!apiKey || !apiSecret) {
      const missing = exchangeId === 'bybit' ? 'BYBIT_API_KEY/BYBIT_API_SECRET' : 'BINANCE_API_KEY/BINANCE_API_SECRET';
      throw new Error(`${missing} (or EXCHANGE_API_KEY/EXCHANGE_API_SECRET) environment variables are required`);
    }

    // 初始化服务
    const binanceService = new BinanceService(apiKey, apiSecret, undefined, exchangeId);
    const tradeHistoryService = new TradeHistoryService(binanceService);
    const profitCalculator = new ProfitCalculator();
    const orderHistoryManager = new OrderHistoryManager();

    logInfo('📊 Starting profit analysis...');

    // 解析时间参数
    let timeFilter = options.since;
    let timeRange;

    if (!timeFilter) {
      // 如果没有指定时间，使用order-history的创建时间
      const createdAt = orderHistoryManager.getCreatedAt();
      timeRange = {
        startTime: createdAt,
        endTime: Date.now()
      };
      const startDate = new Date(createdAt).toISOString().split('T')[0];
      logInfo(`📅 Using order history start time: ${startDate} (${new Date(createdAt).toISOString()})`);
    } else {
      // 用户指定了时间参数
      try {
        timeRange = TradeHistoryService.parseTimeFilter(timeFilter);
      } catch (error) {
        throw new Error(`Invalid time format: ${timeFilter}. ${error instanceof Error ? error.message : ''}`);
      }
    }

    logInfo(`📅 Analyzing trades from: ${new Date(timeRange.startTime).toISOString()} to ${new Date(timeRange.endTime).toISOString()}`);

    // 设置默认值：默认包含浮动盈亏
    const includeUnrealized = !options.excludeUnrealized;
    const unrealizedOnly = options.unrealizedOnly || false;

    // 处理参数冲突
    if (options.excludeUnrealized && unrealizedOnly) {
      logWarn('⚠️ --unrealized-only overrides --exclude-unrealized');
    } else if (options.excludeUnrealized) {
      logInfo('📊 Excluding unrealized P&L from analysis');
    }

    // 获取交易记录
    const trades = await tradeHistoryService.getTrades({
      symbol: options.pair,
      startTime: timeRange.startTime,
      endTime: timeRange.endTime,
      forceRefresh: options.refresh
    });

    if (trades.length === 0 && !includeUnrealized && !unrealizedOnly) {
      logWarn('⚠️ No trades found in the specified time range');
      return;
    }

    logInfo(`📈 Found ${trades.length} trades, analyzing profitability...`);

    // 分析盈利情况
    const analysis: ProfitAnalysis = profitCalculator.analyzeProfit(trades);

    // 如果需要包含浮动盈亏，获取当前仓位信息
    let unrealizedPnl = 0;
    let positions: any[] = [];

    if (includeUnrealized || unrealizedOnly) {
      try {
        if (unrealizedOnly) {
          logInfo('📊 Fetching current positions for unrealized P&L analysis only...');
        } else {
          logInfo('📊 Fetching current positions for unrealized P&L...');
        }
        positions = await binanceService.getPositions();
        unrealizedPnl = positions.reduce((sum, pos) => sum + parseFloat(pos.unRealizedProfit), 0);
        logInfo(`✅ Found ${positions.length} open positions with unrealized P&L: ${ProfitCalculator.formatCurrency(unrealizedPnl)} USDT`);
      } catch (error) {
        logWarn(`⚠️ Failed to fetch positions: ${error instanceof Error ? error.message : 'Unknown error'}`);
        if (unrealizedOnly) {
          throw new Error('Failed to fetch positions for unrealized P&L analysis');
        }
        logInfo('📊 Proceeding with realized profit analysis only...');
      }
    }

    // 输出结果
    if (options.format === 'json') {
      outputJson(analysis, unrealizedPnl, positions, unrealizedOnly);
    } else {
      outputTable(analysis, options, unrealizedPnl, positions, unrealizedOnly, includeUnrealized);
    }

    // 清理资源
    binanceService.destroy();

  } catch (error) {
    handleError(error, 'Profit analysis failed');
  }
}

/**
 * 以表格格式输出结果
 */
function outputTable(analysis: ProfitAnalysis, options: ProfitCommandOptions, unrealizedPnl: number = 0, positions: any[] = [], unrealizedOnly: boolean = false, includeUnrealized: boolean = true): void {
  const { overall, bySymbol } = analysis;

  // 如果是仅显示浮动盈亏模式
  if (unrealizedOnly) {
    logInfo('\n' + '='.repeat(80));
    logInfo('📊 UNREALIZED P&L ANALYSIS REPORT');
    logInfo('='.repeat(80));

    logInfo('\n📈 CURRENT POSITIONS:');
    logInfo('-'.repeat(50));
    logInfo(`Total Positions: ${positions.length}`);
    logInfo(`Total Unrealized P&L: ${ProfitCalculator.formatCurrency(unrealizedPnl)} USDT`);

    if (unrealizedPnl > 0) {
      logInfo(`✅ Profitable Positions: ${positions.filter(pos => parseFloat(pos.unRealizedProfit) > 0).length}`);
      logInfo(`⚠️ Losing Positions: ${positions.filter(pos => parseFloat(pos.unRealizedProfit) < 0).length}`);
    } else if (unrealizedPnl < 0) {
      logInfo(`⚠️ Losing Positions: ${positions.filter(pos => parseFloat(pos.unRealizedProfit) < 0).length}`);
      logInfo(`✅ Profitable Positions: ${positions.filter(pos => parseFloat(pos.unRealizedProfit) > 0).length}`);
    } else {
      logInfo(`➖ Breakeven Positions: All positions at break-even`);
    }

    // 显示当前持仓详情
    if (positions.length > 0) {
      logInfo('\n📋 POSITION DETAILS:');
      logInfo('-'.repeat(120));
      logInfo('Symbol\t\tPosition Size\tEntry Price\tMark Price\tUnrealized P&L\tLeverage\tP&L %');
      logInfo('-'.repeat(120));

      for (const pos of positions) {
        const symbol = pos.symbol.padEnd(12);
        const positionAmt = parseFloat(pos.positionAmt).toFixed(4).padEnd(12);
        const entryPrice = parseFloat(pos.entryPrice).toFixed(4).padEnd(12);
        const markPrice = parseFloat(pos.markPrice).toFixed(4).padEnd(12);
        const unrealized = parseFloat(pos.unRealizedProfit);
        const pnlIndicator = unrealized >= 0 ? '📈' : '📉';
        const pnlStr = `${pnlIndicator}${ProfitCalculator.formatCurrency(unrealized, 4)}`.padEnd(12);
        const leverage = pos.leverage.padEnd(8);

        // 计算盈亏百分比（相对于开仓价值）
        const entryValue = Math.abs(parseFloat(pos.positionAmt) * parseFloat(pos.entryPrice));
        const pnlPercentage = entryValue > 0 ? (unrealized / entryValue) * 100 : 0;
        const pctStr = `${ProfitCalculator.formatPercentage(pnlPercentage, 2)}`.padEnd(8);

        logInfo(`${symbol}\t${positionAmt}\t${entryPrice}\t${markPrice}\t${pnlStr}\t${leverage}\t${pctStr}`);
      }
    }

    logInfo('\n' + '='.repeat(80));
    return;
  }

  logInfo('\n' + '='.repeat(80));
  logInfo('📊 PROFIT ANALYSIS REPORT');
  logInfo('='.repeat(80));

  // 总体统计（仅在不是仅显示浮动盈亏模式时显示）
  if (!unrealizedOnly) {
    logInfo('\n📈 OVERALL STATISTICS:');
    logInfo('-'.repeat(50));
    logInfo(`Total Completed Trades: ${overall.totalTrades}`);
    logInfo(`Winning Trades: ${overall.winningTrades}`);
    logInfo(`Losing Trades: ${overall.losingTrades}`);
    logInfo(`Win Rate: ${ProfitCalculator.formatPercentage(overall.winRate)}`);
    logInfo('');
    logInfo(`Total Gross Profit: ${ProfitCalculator.formatCurrency(overall.totalGrossProfit)} USDT`);
    logInfo(`Total Commission: ${ProfitCalculator.formatCurrency(overall.totalCommission)} USDT`);
    logInfo(`Total Net Profit (Realized): ${ProfitCalculator.formatCurrency(overall.totalNetProfit)} USDT`);

    // 显示浮动盈亏信息
    if (includeUnrealized && !unrealizedOnly) {
      logInfo('');
      logInfo(`Current Positions: ${positions.length}`);
      logInfo(`Unrealized P&L: ${ProfitCalculator.formatCurrency(unrealizedPnl)} USDT`);

      const totalPnl = overall.totalNetProfit + unrealizedPnl;
      const pnlIndicator = totalPnl >= 0 ? '📈' : '📉';
      logInfo(`Total P&L (Realized + Unrealized): ${pnlIndicator}${ProfitCalculator.formatCurrency(totalPnl)} USDT`);
    }
  }

  // 交易统计（仅在不是仅显示浮动盈亏模式时显示）
  if (!unrealizedOnly) {
    logInfo('');
    logInfo(`Average Win: ${ProfitCalculator.formatCurrency(overall.averageProfit)} USDT`);
    logInfo(`Average Loss: ${ProfitCalculator.formatCurrency(overall.averageLoss)} USDT`);
    logInfo(`Max Profit: ${ProfitCalculator.formatCurrency(overall.maxProfit)} USDT`);
    logInfo(`Max Loss: ${ProfitCalculator.formatCurrency(overall.maxLoss)} USDT`);
  }
  // 交易统计（仅在不是仅显示浮动盈亏模式时显示）
  if (!unrealizedOnly) {
    logInfo('');
    logInfo(`Average Trade Duration: ${ProfitCalculator.formatDuration(overall.averageDuration)}`);
    logInfo(`Total Duration: ${ProfitCalculator.formatDuration(overall.totalDuration)}`);

    // 按交易对分组统计
    if (options.groupBy === 'symbol' && Object.keys(bySymbol).length > 1) {
      logInfo('\n📊 BREAKDOWN BY SYMBOL:');
      logInfo('-'.repeat(50));

      const symbols = Object.keys(bySymbol).sort();
      for (const symbol of symbols) {
        const symbolStats = bySymbol[symbol].stats;
        const netProfit = symbolStats.totalNetProfit;
        const profitIndicator = netProfit >= 0 ? '📈' : '📉';

        logInfo(`${profitIndicator} ${symbol}:`);
        logInfo(`  Trades: ${symbolStats.totalTrades} | Win Rate: ${ProfitCalculator.formatPercentage(symbolStats.winRate)}`);
        logInfo(`  Net Profit: ${ProfitCalculator.formatCurrency(netProfit)} USDT | Commission: ${ProfitCalculator.formatCurrency(symbolStats.totalCommission)} USDT`);
        logInfo(`  Max Profit: ${ProfitCalculator.formatCurrency(symbolStats.maxProfit)} USDT | Max Loss: ${ProfitCalculator.formatCurrency(symbolStats.maxLoss)} USDT`);
        logInfo('');
      }
    }
  }

  // 当前持仓详情（仅在不是仅显示浮动盈亏模式时显示）
  if (!unrealizedOnly && includeUnrealized && positions.length > 0) {
    logInfo('\n📋 CURRENT POSITIONS:');
    logInfo('-'.repeat(120));
    logInfo('Symbol\t\tPosition Size\tEntry Price\tMark Price\tUnrealized P&L\tLeverage');
    logInfo('-'.repeat(120));

    for (const pos of positions) {
      const symbol = pos.symbol.padEnd(12);
      const positionAmt = parseFloat(pos.positionAmt).toFixed(4).padEnd(12);
      const entryPrice = parseFloat(pos.entryPrice).toFixed(4).padEnd(12);
      const markPrice = parseFloat(pos.markPrice).toFixed(4).padEnd(12);
      const unrealized = parseFloat(pos.unRealizedProfit);
      const pnlIndicator = unrealized >= 0 ? '📈' : '📉';
      const pnlStr = `${pnlIndicator}${ProfitCalculator.formatCurrency(unrealized, 4)}`.padEnd(12);
      const leverage = pos.leverage.padEnd(8);

      logInfo(`${symbol}\t${positionAmt}\t${entryPrice}\t${markPrice}\t${pnlStr}\t${leverage}`);
    }
  }

  // 最近交易详情
  logInfo('\n📋 NOTE: Individual trade details are now simplified to focus on overall profitability statistics.');
  logInfo('Each trade record in Binance API represents completed transactions with realized P&L already calculated.');

  // 分析总结（仅在不是仅显示浮动盈亏模式时显示）
  if (!unrealizedOnly) {
    logInfo('\n📝 ANALYSIS SUMMARY:');
    logInfo('-'.repeat(50));
    // 计算包含浮动盈亏的总盈亏
    const totalPnl = includeUnrealized ? overall.totalNetProfit + unrealizedPnl : overall.totalNetProfit;

    if (totalPnl > 0) {
      const pnlType = includeUnrealized ? 'Total P&L (Realized + Unrealized)' : 'Net Profit';
      logInfo(`✅ Profitable Strategy: ${pnlType} of ${ProfitCalculator.formatCurrency(totalPnl)} USDT`);
    } else if (totalPnl < 0) {
      const pnlType = includeUnrealized ? 'Total P&L (Realized + Unrealized)' : 'Net Loss';
      logInfo(`⚠️ Unprofitable Strategy: ${pnlType} of ${ProfitCalculator.formatCurrency(Math.abs(totalPnl))} USDT`);
    } else {
      logInfo(`➖ Breakeven Strategy: No net profit or loss`);
    }

    if (overall.winRate >= 50) {
      logInfo(`✅ Good Win Rate: ${ProfitCalculator.formatPercentage(overall.winRate)}`);
    } else {
      logInfo(`⚠️ Low Win Rate: ${ProfitCalculator.formatPercentage(overall.winRate)}`);
    }

    const avgTradeProfit = overall.totalTrades > 0 ? overall.totalNetProfit / overall.totalTrades : 0;
    if (avgTradeProfit > 0) {
      logInfo(`✅ Positive Average Trade: ${ProfitCalculator.formatCurrency(avgTradeProfit)} USDT`);
    } else {
      logInfo(`⚠️ Negative Average Trade: ${ProfitCalculator.formatCurrency(avgTradeProfit)} USDT`);
    }

    // 浮动盈亏相关提示
    if (includeUnrealized && positions.length > 0) {
      const unrealizedPercentage = Math.abs(unrealizedPnl) > 0 ? (Math.abs(unrealizedPnl) / Math.abs(totalPnl)) * 100 : 0;
      if (Math.abs(unrealizedPercentage) > 20) {
        logInfo(`⚠️ High Unrealized P&L Exposure: ${ProfitCalculator.formatPercentage(unrealizedPercentage)} of total P&L`);
      }
    }
  }

  logInfo('\n' + '='.repeat(80));
}

/**
 * 以JSON格式输出结果
 */
function outputJson(analysis: ProfitAnalysis, unrealizedPnl: number = 0, positions: any[] = [], unrealizedOnly: boolean = false): void {
  const result = {
    ...analysis,
    unrealizedPnl,
    totalPnl: analysis.overall.totalNetProfit + unrealizedPnl,
    currentPositions: positions.map(pos => ({
      symbol: pos.symbol,
      positionSize: parseFloat(pos.positionAmt),
      entryPrice: parseFloat(pos.entryPrice),
      markPrice: parseFloat(pos.markPrice),
      unrealizedPnl: parseFloat(pos.unRealizedProfit),
      leverage: parseFloat(pos.leverage),
      percentage: analysis.overall.totalNetProfit !== 0 ? (parseFloat(pos.unRealizedProfit) / analysis.overall.totalNetProfit) * 100 : 0
    })),
    mode: unrealizedOnly ? 'unrealized-only' : 'full-analysis'
  };
  console.log(JSON.stringify(result, null, 2));
}
