import { Position, FollowPlan, AgentAccount, FollowOptions } from '../scripts/analyze-api';
import { ProfitExitRecord, ManualCloseRecord } from './order-history-manager';
import { PriceToleranceCheck } from './risk-manager';
import { CapitalAllocationResult } from './futures-capital-manager';
import { PositionManager } from './position-manager';
import { OrderHistoryManager } from './order-history-manager';
import { RiskManager } from './risk-manager';
import { FuturesCapitalManager } from './futures-capital-manager';
import { TradingExecutor } from './trading-executor';
import { BinanceService } from './binance-service';
import {
  LOGGING_CONFIG,
  TIME_CONFIG,
  LogLevel
} from '../config/constants';
import {
  handleErrors,
  safeExecute
} from '../utils/errors';
import { logInfo, logDebug, logVerbose, logWarn, logError } from '../utils/logger';

/**
 * 仓位变化检测结果
 */
interface PositionChange {
  symbol: string;
  type: 'entry_changed' | 'new_position' | 'position_closed' | 'no_change' | 'profit_target_reached' | 'manual_closed';
  currentPosition?: Position;
  previousPosition?: Position;
  profitPercentage?: number; // 盈利百分比（仅当type为profit_target_reached时有值）
}

/**
 * 跟单服务
 * 负责处理跟单逻辑，包括仓位变化检测、资金分配等
 * 
 * 注意：不再使用内存缓存 lastPositions
 * 所有历史状态都从 order-history.json 重建，确保持久化和一致性
 */
export class FollowService {
  constructor(
    private positionManager: PositionManager,
    private orderHistoryManager: OrderHistoryManager,
    private riskManager: RiskManager,
  private capitalManager: FuturesCapitalManager,
  private tradingExecutor: TradingExecutor
  ) {}

  private getExchangeLabel(): string {
    const service = (this.positionManager as any)?.binanceService as BinanceService | undefined;
    return service?.id ? service.id.toUpperCase() : 'BINANCE';
  }

  /**
   * 从订单历史重建上次仓位状态
   * 这样即使程序重启也能正确检测仓位变化
   */
  private rebuildLastPositionsFromHistory(agentId: string, currentPositions: Position[]): Position[] {
    const processedOrders = this.orderHistoryManager.getProcessedOrdersByAgent(agentId);
    
    if (!processedOrders || processedOrders.length === 0) {
      logDebug(`📚 No order history found for agent ${agentId}, treating all positions as new`);
      return [];
    }

    // 根据订单历史重建上次的仓位状态
    const lastPositionsMap = new Map<string, Position>();
    
    // 遍历当前仓位，查找对应的历史订单
    for (const currentPos of currentPositions) {
      // 查找该交易对最近的已处理订单
      const symbolOrders = processedOrders
        .filter(order => order.symbol === currentPos.symbol)
        .sort((a, b) => b.timestamp - a.timestamp); // 按时间倒序
      
      if (symbolOrders.length > 0) {
        const lastOrder = symbolOrders[0];
        
        // 重建上次的仓位信息
        lastPositionsMap.set(currentPos.symbol, {
          symbol: currentPos.symbol,
          entry_price: lastOrder.price || currentPos.entry_price,
          quantity: lastOrder.side === 'BUY' ? lastOrder.quantity : -lastOrder.quantity,
          leverage: currentPos.leverage,
          entry_oid: lastOrder.entryOid,
          tp_oid: 0, // 历史数据中没有止盈订单ID
          sl_oid: 0, // 历史数据中没有止损订单ID
          margin: 0, // 历史数据中没有保证金信息
          current_price: currentPos.current_price,
          unrealized_pnl: 0,
          confidence: currentPos.confidence,
          exit_plan: currentPos.exit_plan
        });
      }
    }

    const rebuiltPositions = Array.from(lastPositionsMap.values());
    logDebug(`📚 Rebuilt ${rebuiltPositions.length} positions from order history for agent ${agentId}`);
    
    return rebuiltPositions;
  }

  /**
   * 跟单特定 AI Agent
   */
  @handleErrors(Error, 'FollowService.followAgent')
  async followAgent(
    agentId: string,
    currentPositions: Position[],
    options?: FollowOptions
  ): Promise<FollowPlan[]> {
    logInfo(`${LOGGING_CONFIG.EMOJIS.ROBOT} Following agent: ${agentId}`);

    // 验证和显示跟单配置信息
    if (options?.profitTarget) {
      if (options.profitTarget <= 0 || options.profitTarget > 1000) {
        logWarn(`⚠️ Invalid profit target: ${options.profitTarget}%. Must be between 0 and 1000. Using default behavior.`);
        options.profitTarget = undefined;
      } else {
        logInfo(`${LOGGING_CONFIG.EMOJIS.TARGET} Profit target enabled: ${options.profitTarget}%`);
        if (options?.autoRefollow) {
          logInfo(`${LOGGING_CONFIG.EMOJIS.CLOSING} Auto-refollow enabled: will reset order status after profit target exit or manual closure`);
        } else {
          logInfo(`${LOGGING_CONFIG.EMOJIS.INFO} Auto-refollow disabled: will not refollow after profit target exit`);
        }
      }
    } else if (options?.autoRefollow) {
      // 即使没有设置盈利目标，auto-refollow 也会检测手工平仓
      logInfo(`${LOGGING_CONFIG.EMOJIS.CLOSING} Auto-refollow enabled: will detect manual closures and allow refollowing`);
    }

    // 验证资金分配参数
    const validation = this.capitalManager.validateAllocationOptions({
      totalMargin: options?.totalMargin,
      fixedAmountPerCoin: options?.fixedAmountPerCoin
    });

    if (!validation.isValid) {
      logError(`❌ ${validation.error}`);
      return [];
    }

    // 显示资金分配模式信息
    if (options?.fixedAmountPerCoin) {
      logInfo(`${LOGGING_CONFIG.EMOJIS.MONEY} Fixed amount allocation enabled: $${options.fixedAmountPerCoin.toFixed(2)} per coin`);
    } else if (options?.totalMargin) {
      logInfo(`${LOGGING_CONFIG.EMOJIS.MONEY} Proportional allocation enabled: Total margin $${options.totalMargin.toFixed(2)}`);
    }

    // 0. 重新加载订单历史,确保使用最新数据(支持手动修改文件)
    this.orderHistoryManager.reloadHistory();

    // 1. 清理孤立的挂单 (没有对应仓位的止盈止损单)
    await this.positionManager.cleanOrphanedOrders();

    // 1. 每次都从订单历史重建上次仓位状态
    // order-history.json 是唯一的真实来源，确保程序重启或 API 数据不变时都能正确检测变化
    const previousPositions = this.rebuildLastPositionsFromHistory(agentId, currentPositions);

    const followPlans: FollowPlan[] = [];

    // 2. 检测仓位变化
    const changes = await this.detectPositionChanges(currentPositions, previousPositions || [], options);

    // 2.1 检测手工平仓（仅在启用 auto-refollow 时）
    if (options?.autoRefollow) {
      const manualClosures = await this.detectManualClosure(currentPositions, previousPositions || [], options);
      if (manualClosures.length > 0) {
        logInfo(`🔧 Detected ${manualClosures.length} manual closure(s)`);
        changes.push(...manualClosures);
      }
    }

    // 3. 处理每种变化
    for (const change of changes) {
      const plans = await this.handlePositionChange(change, agentId, options);
      followPlans.push(...plans);
    }

    // 4. 检查止盈止损条件
    const exitPlans = this.checkExitConditions(currentPositions, agentId);
    followPlans.push(...exitPlans);

    // 5. 应用资金分配
    if (options?.totalMargin && options.totalMargin > 0) {
      await this.applyCapitalAllocation(followPlans, currentPositions, options!.totalMargin, agentId);
    } else if (options?.fixedAmountPerCoin && options.fixedAmountPerCoin > 0) {
      await this.applyFixedAmountAllocation(followPlans, currentPositions, options.fixedAmountPerCoin, agentId);
    }

    // 6. 注意：不要在这里更新 lastPositions！
    // lastPositions 应该在订单成功执行后才更新（在 PositionManager 中）
    // 这样才能确保只有真正执行的订单才会被记录

    logInfo(`${LOGGING_CONFIG.EMOJIS.SUCCESS} Generated ${followPlans.length} follow plan(s) for agent ${agentId}`);
    return followPlans;
  }

  /**
   * 检测仓位变化
   */
  private async detectPositionChanges(
    currentPositions: Position[],
    previousPositions: Position[],
    options?: FollowOptions
  ): Promise<PositionChange[]> {
    const changes: PositionChange[] = [];
    const currentPositionsMap = new Map(currentPositions.map(p => [p.symbol, p]));
    const previousPositionsMap = new Map(previousPositions.map(p => [p.symbol, p]));

    // 检查当前所有仓位
    for (const [symbol, currentPosition] of currentPositionsMap) {
      const previousPosition = previousPositionsMap.get(symbol);

      // 检查盈利目标 (仅在当前有仓位时)
      if (options?.profitTarget && currentPosition.quantity !== 0) {
        const profitPercentage = await this.calculateProfitPercentage(currentPosition);
        logInfo(`💰 ${symbol} current profit: ${profitPercentage.toFixed(2)}% (target: ${options.profitTarget}%)`);

        if (profitPercentage >= options.profitTarget) {
          logInfo(`🎯 Profit target reached for ${symbol}: ${profitPercentage.toFixed(2)}% >= ${options.profitTarget}%`);
          changes.push({
            symbol,
            type: 'profit_target_reached',
            currentPosition,
            previousPosition,
            profitPercentage
          });
          continue; // 如果已达到盈利目标，跳过其他变化检测
        }
      }

      if (!previousPosition) {
        // 新仓位
        if (currentPosition.quantity !== 0) {
          changes.push({
            symbol,
            type: 'new_position',
            currentPosition,
            previousPosition
          });
        }
      } else {
        // 检查 entry_oid 变化（先平仓再开仓）
        if (previousPosition.entry_oid !== currentPosition.entry_oid && currentPosition.quantity !== 0) {
          logInfo(`🔍 Detected OID change for ${symbol}: ${previousPosition.entry_oid} → ${currentPosition.entry_oid}`);
          changes.push({
            symbol,
            type: 'entry_changed',
            currentPosition,
            previousPosition
          });
        } else if (previousPosition.quantity !== 0 && currentPosition.quantity === 0) {
          // 仓位已平
          changes.push({
            symbol,
            type: 'position_closed',
            currentPosition,
            previousPosition
          });
        } else {
          // 调试: 显示为什么没有检测到变化
          logVerbose(`🔍 ${symbol}: Previous OID=${previousPosition.entry_oid}, Current OID=${currentPosition.entry_oid}, Qty=${currentPosition.quantity}`);
        }
      }
    }

    return changes;
  }

  /**
   * 检测手工平仓情况
   * 比较NOF1 API返回的仓位与币安实际仓位，检测用户是否手工平仓
   */
  private async detectManualClosure(
    currentPositions: Position[],
    previousPositions: Position[],
    options?: FollowOptions
  ): Promise<PositionChange[]> {
    const manualClosures: PositionChange[] = [];

    // 只有在启用 auto-refollow 时才检测手工平仓
    if (!options?.autoRefollow) {
      return manualClosures;
    }

    try {
      // 获取币安实际仓位
      const binancePositions = await this.positionManager['binanceService'].getAllPositions();
      
      // 遍历之前的仓位，检查是否被手工平仓
      for (const prevPos of previousPositions) {
        // 跳过已经是零仓位的
        if (prevPos.quantity === 0) {
          continue;
        }

        // 查找当前NOF1仓位
        const currentPos = currentPositions.find(p => p.symbol === prevPos.symbol);
        
        // 如果NOF1仍然显示有仓位（OID未变）
        if (currentPos && currentPos.entry_oid === prevPos.entry_oid && currentPos.quantity !== 0) {
          // 检查币安是否真的有这个仓位
          const targetSymbol = this.positionManager['binanceService'].convertSymbol(currentPos.symbol);
          const binancePosition = binancePositions.find(
            p => p.symbol === targetSymbol && parseFloat(p.positionAmt) !== 0
          );

          // 如果NOF1显示有仓位但币安没有，说明被手工平仓了
          if (!binancePosition) {
            logInfo(`🔧 Detected manual closure: ${currentPos.symbol} (OID: ${currentPos.entry_oid})`);
            logInfo(`   📊 NOF1 shows position: ${currentPos.quantity} @ $${currentPos.entry_price}`);
            logInfo(`   📊 Binance has no position for ${targetSymbol}`);
            
            manualClosures.push({
              symbol: currentPos.symbol,
              type: 'manual_closed',
              currentPosition: currentPos,
              previousPosition: prevPos
            });
          }
        }
      }
    } catch (error) {
      logWarn(`⚠️ Failed to detect manual closures: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return manualClosures;
  }

  /**
   * 处理手工平仓
   * 记录手工平仓事件并重置订单历史，允许重新跟单
   */
  private handleManualClosure(
    change: PositionChange,
    agentId: string,
    options?: FollowOptions
  ): void {
    const { currentPosition } = change;
    if (!currentPosition) return;

    logInfo(`🔧 Handling manual closure for ${currentPosition.symbol}`);

    // 记录手工平仓事件
    this.orderHistoryManager.addManualCloseRecord({
      symbol: currentPosition.symbol,
      entryOid: currentPosition.entry_oid,
      detectedAt: Date.now(),
      reason: `Manual closure detected - NOF1 shows position but Binance has none`
    });

    // 重置该币种的订单历史，允许重新跟单
    if (options?.autoRefollow) {
      logInfo(`🔄 Auto-refollow enabled: Resetting order status for ${currentPosition.symbol}`);
      this.orderHistoryManager.resetSymbolOrderStatus(currentPosition.symbol, currentPosition.entry_oid);
      logInfo(`📝 Note: ${currentPosition.symbol} will be refollowed when NOF1 opens a new position`);
    }
  }

  /**
   * 计算仓位盈利百分比（使用币安真实数据）
   */
  private async calculateProfitPercentage(position: Position): Promise<number> {
    try {
      if (position.quantity === 0) {
        return 0;
      }

      const exchangeLabel = this.getExchangeLabel();

      // 从币安API获取真实仓位数据
      const exchange = (this.positionManager as any).binanceService as BinanceService;
      const binancePositions = await exchange.getAllPositions();
      const targetSymbol = exchange.convertSymbol(position.symbol);
      const binancePosition = binancePositions.find(p => p.symbol === targetSymbol && parseFloat(p.positionAmt) !== 0);

      if (!binancePosition) {
        logWarn(`⚠️ No ${exchangeLabel} position found for ${position.symbol} (${targetSymbol})`);
        return 0;
      }

      // 使用币安的真实未实现盈亏数据
      const unrealizedProfit = parseFloat(binancePosition.unRealizedProfit);
      const entryPrice = parseFloat(binancePosition.entryPrice);
      const positionAmt = parseFloat(binancePosition.positionAmt);
      const marginType = binancePosition.marginType;

      // 计算保证金基础
      let marginBase = 0;
      if (marginType === 'ISOLATED') {
        marginBase = parseFloat(binancePosition.isolatedMargin!);
      } else {
        // 交叉保证金，使用实际占用保证金
        marginBase = Math.abs(positionAmt * entryPrice) / parseFloat(binancePosition.leverage);
      }

      // 计算盈利百分比
      const profitPercentage = marginBase > 0 ? (unrealizedProfit / marginBase) * 100 : 0;

      // 调试信息
      logInfo(`📈 ${position.symbol} ${exchangeLabel} profit data:`);
      logInfo(`   💰 Unrealized P&L: $${unrealizedProfit.toFixed(2)}`);
      logInfo(`   💰 Margin: $${marginBase.toFixed(2)} (${marginType})`);
      logInfo(`   📊 Profit %: ${profitPercentage.toFixed(2)}%`);
      logInfo(`   📊 ${exchangeLabel} entry: $${entryPrice.toFixed(2)}, Agent entry: $${position.entry_price}`);

      // 检查计算结果的合理性
      if (!isFinite(profitPercentage)) {
        logWarn(`⚠️ Invalid profit calculation for ${position.symbol}: ${profitPercentage}`);
        return 0;
      }

      return profitPercentage;
    } catch (error) {
      logError(`❌ Error calculating profit percentage for ${position.symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return 0;
    }
  }

  /**
   * 处理仓位变化
   */
  private async handlePositionChange(
    change: PositionChange,
    agentId: string,
    options?: FollowOptions
  ): Promise<FollowPlan[]> {
    const plans: FollowPlan[] = [];

    switch (change.type) {
      case 'entry_changed':
        await this.handleEntryChanged(change, agentId, plans, options);
        break;

      case 'new_position':
        await this.handleNewPosition(change, agentId, plans, options);
        break;

      case 'position_closed':
        this.handlePositionClosed(change, agentId, plans, options);
        break;

      case 'profit_target_reached':
        await this.handleProfitTargetReached(change, agentId, plans, options);
        break;

      case 'manual_closed':
        this.handleManualClosure(change, agentId, options);
        break;

      case 'no_change':
        // 不处理
        break;
    }

    return plans;
  }

  /**
   * 处理 entry_oid 变化(先平仓再开仓)
   */
  private async handleEntryChanged(
    change: PositionChange,
    agentId: string,
    plans: FollowPlan[],
    options?: FollowOptions
  ): Promise<void> {
    const { previousPosition, currentPosition } = change;
    if (!previousPosition || !currentPosition) return;

    const exchangeLabel = this.getExchangeLabel();

    // 检查新订单是否已处理（去重）
    if (this.orderHistoryManager.isOrderProcessed(currentPosition.entry_oid, currentPosition.symbol)) {
      logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} SKIPPED: ${currentPosition.symbol} new entry (OID: ${currentPosition.entry_oid}) already processed`);
      return;
    }

    // 检查交易所是否真的有该币种的仓位
    let hasActualPosition = false;
    let releasedMargin: number | undefined;
    
    try {
      const exchange = (this.positionManager as any).binanceService as BinanceService;
      const binancePositions = await exchange.getPositions();
      const targetSymbol = exchange.convertSymbol(currentPosition.symbol);
      
      const existingPosition = binancePositions.find(
        p => p.symbol === targetSymbol && parseFloat(p.positionAmt) !== 0
      );
      
      hasActualPosition = !!existingPosition;
      
      if (existingPosition) {
        const positionAmt = parseFloat(existingPosition.positionAmt);
        logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Found existing position on ${exchangeLabel}: ${existingPosition.symbol} ${positionAmt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(positionAmt)}`);
      } else {
        logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} No existing position found on ${exchangeLabel} for ${targetSymbol}`);
      }
    } catch (error) {
      console.warn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to check existing positions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // 只有在真的有仓位时才执行平仓操作
    if (hasActualPosition) {
      // 1. 平仓前获取账户余额
      let balanceBeforeClose: number | undefined;
      try {
        const accountInfo = await this.tradingExecutor.getAccountInfo();
        balanceBeforeClose = parseFloat(accountInfo.availableBalance);
        logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Balance before closing: $${balanceBeforeClose.toFixed(2)} USDT`);
      } catch (error) {
        logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get balance before close: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      const closeReason = `Entry order changed (old: ${previousPosition.entry_oid} → new: ${currentPosition.entry_oid}) - closing old position`;

      // 2. 平仓旧仓位
      const closeResult = await this.positionManager.closePosition(previousPosition.symbol, closeReason);

      if (closeResult.success) {
        // closePosition 内部已经包含验证逻辑(等待2秒并验证仓位关闭),无需额外等待

        // 3. 平仓后获取账户余额,计算释放的资金
        if (balanceBeforeClose !== undefined) {
          try {
            const accountInfo = await this.tradingExecutor.getAccountInfo();
            const balanceAfterClose = parseFloat(accountInfo.availableBalance);
            releasedMargin = balanceAfterClose - balanceBeforeClose;
            logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Balance after closing: $${balanceAfterClose.toFixed(2)} USDT`);
            logInfo(`${LOGGING_CONFIG.EMOJIS.MONEY} Released margin from closing: $${releasedMargin.toFixed(2)} USDT (${releasedMargin >= 0 ? 'Profit' : 'Loss'})`);
            
            // 如果释放的资金为负数(亏损)或太小,则不使用
            if (releasedMargin <= 0) {
              logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Position closed with loss, insufficient margin released. Will use normal capital allocation.`);
              releasedMargin = undefined;
            }
          } catch (error) {
            logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get balance after close: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      } else {
        logError(`${LOGGING_CONFIG.EMOJIS.ERROR} Failed to close old position for ${currentPosition.symbol}, skipping new position opening`);
        return;
      }
    } else {
      logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} No actual position to close, will use normal capital allocation for new position`);
    }

    // 添加价格容忍度检查（带方向性判断）
    const positionSide = currentPosition.quantity > 0 ? "BUY" : "SELL";
    const priceTolerance = this.riskManager.checkPriceTolerance(
      currentPosition.entry_price,
      currentPosition.current_price,
      positionSide,
      currentPosition.symbol
    );

    if (!priceTolerance.shouldExecute) {
      logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} SKIPPED: ${currentPosition.symbol} - Price not acceptable: ${priceTolerance.reason}`);
      return;
    }

    // 统一生成 FollowPlan,携带 releasedMargin 信息
    const followPlan: FollowPlan = {
      action: "ENTER",
      symbol: currentPosition.symbol,
      side: positionSide,
      type: "MARKET",
      quantity: Math.abs(currentPosition.quantity),
      leverage: currentPosition.leverage,
      entryPrice: currentPosition.entry_price,
      reason: releasedMargin && releasedMargin > 0 
        ? `Reopening with released margin $${releasedMargin.toFixed(2)} (OID: ${currentPosition.entry_oid}) by ${agentId}`
        : `Entry order changed (OID: ${currentPosition.entry_oid}) by ${agentId}`,
      agent: agentId,
      timestamp: Date.now(),
      position: currentPosition,
      priceTolerance,
      releasedMargin: releasedMargin && releasedMargin > 0 ? releasedMargin : undefined,
      marginType: options?.marginType
    };

    plans.push(followPlan);
    
    if (releasedMargin && releasedMargin > 0) {
      logInfo(`${LOGGING_CONFIG.EMOJIS.TREND_UP} ENTRY CHANGED (with released margin $${releasedMargin.toFixed(2)}): ${currentPosition.symbol} ${followPlan.side} ${followPlan.quantity} @ ${currentPosition.entry_price} (OID: ${currentPosition.entry_oid})`);
    } else {
      logInfo(`${LOGGING_CONFIG.EMOJIS.TREND_UP} ENTRY CHANGED: ${currentPosition.symbol} ${followPlan.side} ${followPlan.quantity} @ ${currentPosition.entry_price} (OID: ${currentPosition.entry_oid})`);
    }
    logDebug(`${LOGGING_CONFIG.EMOJIS.MONEY} Price Check: Entry $${currentPosition.entry_price} vs Current $${currentPosition.current_price} - ${priceTolerance.reason}`);
  }

  /**
   * 处理新仓位
   */
  private async handleNewPosition(
    change: PositionChange,
    agentId: string,
    plans: FollowPlan[],
    options?: FollowOptions
  ): Promise<void> {
    const { currentPosition } = change;
    if (!currentPosition) return;

    const exchangeLabel = this.getExchangeLabel();

    // 检查订单是否已处理（去重）
    if (this.orderHistoryManager.isOrderProcessed(currentPosition.entry_oid, currentPosition.symbol)) {
      logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} SKIPPED: ${currentPosition.symbol} position (OID: ${currentPosition.entry_oid}) already processed`);
      return;
    }

    // 检查交易所是否已有该币种的仓位(防止程序重启后无法检测到 entry_oid 变化)
    let releasedMargin: number | undefined;
    try {
      const exchange = (this.positionManager as any).binanceService as BinanceService;
      const binancePositions = await exchange.getPositions();
      const targetSymbol = exchange.convertSymbol(currentPosition.symbol);
      
      logDebug(`${LOGGING_CONFIG.EMOJIS.SEARCH} Checking for existing positions on ${exchangeLabel} for ${currentPosition.symbol} (converted: ${targetSymbol})...`);
      logVerbose(`${LOGGING_CONFIG.EMOJIS.DATA} Found ${binancePositions.length} total position(s) on ${exchangeLabel}`);
      
      const existingPosition = binancePositions.find(
        p => p.symbol === targetSymbol && parseFloat(p.positionAmt) !== 0
      );

      if (existingPosition) {
        const positionAmt = parseFloat(existingPosition.positionAmt);
        logInfo(`${LOGGING_CONFIG.EMOJIS.WARNING} Found existing position on ${exchangeLabel}: ${existingPosition.symbol} ${positionAmt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(positionAmt)}`);
        logInfo(`${LOGGING_CONFIG.EMOJIS.INFO} Closing existing position before opening new entry (OID: ${currentPosition.entry_oid})...`);
        
        // 获取平仓前余额
        let balanceBeforeClose: number | undefined;
        try {
          const accountInfo = await this.tradingExecutor.getAccountInfo();
          balanceBeforeClose = parseFloat(accountInfo.availableBalance);
          logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Balance before closing: $${balanceBeforeClose.toFixed(2)} USDT`);
        } catch (error) {
          logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get balance before close: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        
        const closeReason = `Closing existing position before opening new entry (OID: ${currentPosition.entry_oid})`;
        const closeResult = await this.positionManager.closePosition(currentPosition.symbol, closeReason);
        
        if (!closeResult.success) {
          logError(`${LOGGING_CONFIG.EMOJIS.ERROR} Failed to close existing position for ${currentPosition.symbol}, skipping new position`);
          return;
        }
        
        // 获取平仓后余额,计算释放的资金
        if (balanceBeforeClose !== undefined) {
          try {
            // 额外等待1秒确保资金完全释放
            await new Promise(resolve => setTimeout(resolve, 1000));
            const accountInfo = await this.tradingExecutor.getAccountInfo();
            const balanceAfterClose = parseFloat(accountInfo.availableBalance);
            releasedMargin = balanceAfterClose - balanceBeforeClose;
            logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Balance after closing: $${balanceAfterClose.toFixed(2)} USDT`);
            logInfo(`${LOGGING_CONFIG.EMOJIS.MONEY} Released margin from closing: $${releasedMargin.toFixed(2)} USDT (${releasedMargin >= 0 ? 'Profit' : 'Loss'})`);
            
            if (releasedMargin <= 0) {
              logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Position closed with loss, insufficient margin released. Will use available balance.`);
              releasedMargin = undefined;
            }
          } catch (error) {
            logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get balance after close: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      } else {
        logDebug(`${LOGGING_CONFIG.EMOJIS.SUCCESS} No existing position found on ${exchangeLabel} for ${targetSymbol}, proceeding with new position`);
      }
    } catch (error) {
      logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to check existing positions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // 添加价格容忍度检查（带方向性判断）
    const positionSide = currentPosition.quantity > 0 ? "BUY" : "SELL";
    const priceTolerance = this.riskManager.checkPriceTolerance(
      currentPosition.entry_price,
      currentPosition.current_price,
      positionSide,
      currentPosition.symbol
    );

    // 统一生成 FollowPlan,携带 releasedMargin 信息
    const followPlan: FollowPlan = {
      action: "ENTER",
      symbol: currentPosition.symbol,
      side: positionSide,
      type: "MARKET",
      quantity: Math.abs(currentPosition.quantity),
      leverage: currentPosition.leverage,
      entryPrice: currentPosition.entry_price,
      reason: releasedMargin && releasedMargin > 0
        ? `Reopening with released margin $${releasedMargin.toFixed(2)} (OID: ${currentPosition.entry_oid}) by ${agentId}`
        : `New position opened by ${agentId} (OID: ${currentPosition.entry_oid})`,
      agent: agentId,
      timestamp: Date.now(),
      position: currentPosition,
      priceTolerance,
      releasedMargin: releasedMargin && releasedMargin > 0 ? releasedMargin : undefined,
      marginType: options?.marginType
    };

    plans.push(followPlan);
    
    if (releasedMargin && releasedMargin > 0) {
      logInfo(`${LOGGING_CONFIG.EMOJIS.TREND_UP} NEW POSITION (with released margin $${releasedMargin.toFixed(2)}): ${currentPosition.symbol} ${followPlan.side} ${followPlan.quantity} @ ${currentPosition.entry_price} (OID: ${currentPosition.entry_oid})`);
    } else {
      logInfo(`${LOGGING_CONFIG.EMOJIS.TREND_UP} NEW POSITION: ${currentPosition.symbol} ${followPlan.side} ${followPlan.quantity} @ ${currentPosition.entry_price} (OID: ${currentPosition.entry_oid})`);
    }
    logDebug(`${LOGGING_CONFIG.EMOJIS.MONEY} Price Check: Entry $${currentPosition.entry_price} vs Current $${currentPosition.current_price} - ${priceTolerance.reason}`);
  }

  /**
   * 处理仓位关闭
   */
  private handlePositionClosed(
    change: PositionChange,
    agentId: string,
    plans: FollowPlan[],
    options?: FollowOptions
  ): void {
    const { previousPosition, currentPosition } = change;
    if (!previousPosition || !currentPosition) return;

    const followPlan: FollowPlan = {
      action: "EXIT",
      symbol: currentPosition.symbol,
      side: previousPosition.quantity > 0 ? "SELL" : "BUY", // 平仓方向相反
      type: "MARKET",
      quantity: Math.abs(previousPosition.quantity),
      leverage: previousPosition.leverage,
      exitPrice: currentPosition.current_price,
      reason: `Position closed by ${agentId}`,
      agent: agentId,
      timestamp: Date.now(),
      marginType: options?.marginType
    };

    plans.push(followPlan);
    logInfo(`${LOGGING_CONFIG.EMOJIS.TREND_DOWN} POSITION CLOSED: ${currentPosition.symbol} ${followPlan.side} ${followPlan.quantity} @ ${currentPosition.current_price}`);
  }

  /**
   * 处理盈利目标达到
   */
  private async handleProfitTargetReached(
    change: PositionChange,
    agentId: string,
    plans: FollowPlan[],
    options?: FollowOptions
  ): Promise<void> {
    const { currentPosition, profitPercentage } = change;
    if (!currentPosition || profitPercentage === undefined) return;

    logInfo(`${LOGGING_CONFIG.EMOJIS.MONEY} PROFIT TARGET REACHED: ${currentPosition.symbol} - Closing position at ${profitPercentage.toFixed(2)}% profit`);

    // 直接执行平仓操作
    try {
      const closeReason = `Profit target reached: ${profitPercentage.toFixed(2)}% by ${agentId}`;
      const closeResult = await this.positionManager.closePosition(currentPosition.symbol, closeReason);

      if (!closeResult.success) {
        logError(`${LOGGING_CONFIG.EMOJIS.ERROR} Failed to close position for profit target: ${currentPosition.symbol} - ${closeResult.error}`);
        return;
      }

      logInfo(`${LOGGING_CONFIG.EMOJIS.SUCCESS} Successfully closed position for profit target: ${currentPosition.symbol}`);

      // 记录盈利退出事件到历史
      this.orderHistoryManager.addProfitExitRecord({
        symbol: currentPosition.symbol,
        entryOid: currentPosition.entry_oid,
        exitPrice: currentPosition.current_price,
        profitPercentage,
        reason: `Profit target ${profitPercentage.toFixed(2)}% reached`
      });

      // 如果启用自动重新跟单，重置订单状态
      if (options?.autoRefollow) {
        logInfo(`🔄 Auto-refollow enabled: Resetting order status for ${currentPosition.symbol} to allow refollowing`);
        this.orderHistoryManager.resetSymbolOrderStatus(currentPosition.symbol, currentPosition.entry_oid);
        logInfo(`📝 Note: ${currentPosition.symbol} will be refollowed in the next polling cycle when oid change is detected`);
      } else {
        logInfo(`📊 Auto-refollow disabled: ${currentPosition.symbol} will not be refollowed automatically`);
      }

    } catch (error) {
      logError(`❌ Error handling profit target for ${currentPosition.symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 检查止盈止损条件
   */
  private checkExitConditions(
    currentPositions: Position[],
    agentId: string
  ): FollowPlan[] {
    const plans: FollowPlan[] = [];

    for (const position of currentPositions) {
      if (position.quantity !== 0 && this.positionManager.shouldExitPosition(position)) {
        const followPlan: FollowPlan = {
          action: "EXIT",
          symbol: position.symbol,
          side: position.quantity > 0 ? "SELL" : "BUY",
          type: "MARKET",
          quantity: Math.abs(position.quantity),
          leverage: position.leverage,
          exitPrice: position.current_price,
          reason: this.positionManager.getExitReason(position),
          agent: agentId,
          timestamp: Date.now()
        };
        plans.push(followPlan);
        logInfo(`${LOGGING_CONFIG.EMOJIS.TARGET} EXIT SIGNAL: ${position.symbol} - ${followPlan.reason}`);
      }
    }

    return plans;
  }

  /**
   * 应用资金分配到 ENTER 操作的跟单计划
   */
  private async applyCapitalAllocation(
    followPlans: FollowPlan[],
    currentPositions: Position[],
    totalMargin: number,
    agentId: string
  ): Promise<void> {
    const enterPlans = followPlans.filter(plan => plan.action === "ENTER");

    if (enterPlans.length === 0) {
      return;
    }

    // 获取对应的仓位信息
    const positionsForAllocation: Position[] = [];
    for (const plan of enterPlans) {
      const position = currentPositions.find(p => p.symbol === plan.symbol);
      if (position && position.margin > 0) {
        positionsForAllocation.push(position);
      }
    }

    if (positionsForAllocation.length === 0) {
      return;
    }

    // 获取可用余额
    let availableBalance: number | undefined;
    try {
      const accountInfo = await this.tradingExecutor.getAccountInfo();
      availableBalance = parseFloat(accountInfo.availableBalance);
      logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Available account balance: ${availableBalance.toFixed(2)} USDT`);
    } catch (balanceError) {
      logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get account balance: ${balanceError instanceof Error ? balanceError.message : 'Unknown error'}`);
    }

    // 执行资金分配
    const allocationResult = this.capitalManager.allocateMargin(positionsForAllocation, totalMargin, availableBalance);

    // 显示分配信息
    this.displayCapitalAllocation(allocationResult, agentId);

    // 将分配结果应用到跟单计划
    this.applyAllocationToPlans(allocationResult, enterPlans);
  }

  /**
   * 显示资金分配信息
   */
  private displayCapitalAllocation(allocationResult: CapitalAllocationResult, agentId: string): void {
    logDebug(`\n${LOGGING_CONFIG.EMOJIS.MONEY} Capital Allocation for ${agentId}:`);
    logDebug('==========================================');
    logDebug(`${LOGGING_CONFIG.EMOJIS.MONEY} Total Margin: $${allocationResult.totalAllocatedMargin.toFixed(2)}`);
    logDebug(`${LOGGING_CONFIG.EMOJIS.TREND_UP} Total Notional Value: $${allocationResult.totalNotionalValue.toFixed(2)}`);
    logDebug('');

    for (const allocation of allocationResult.allocations) {
      logDebug(`${allocation.symbol} - ${allocation.leverage}x leverage`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.CHART} Original Margin: $${allocation.originalMargin.toFixed(2)} (${this.capitalManager.formatPercentage(allocation.allocationRatio)})`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.MONEY} Allocated Margin: $${allocation.allocatedMargin.toFixed(2)}`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.TREND_UP} Notional Value: $${allocation.notionalValue.toFixed(2)}`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.INFO} Adjusted Quantity: ${allocation.adjustedQuantity.toFixed(4)}`);
      logDebug('');
    }

    logDebug('==========================================');
  }

  /**
   * 将分配结果应用到跟单计划
   */
  private applyAllocationToPlans(
    allocationResult: CapitalAllocationResult,
    enterPlans: FollowPlan[]
  ): void {
    for (const allocation of allocationResult.allocations) {
      const followPlan = enterPlans.find(plan => plan.symbol === allocation.symbol);
      if (followPlan) {
        // 更新资金分配信息
        followPlan.originalMargin = allocation.originalMargin;
        followPlan.allocatedMargin = allocation.allocatedMargin;
        followPlan.notionalValue = allocation.notionalValue;
        followPlan.adjustedQuantity = allocation.adjustedQuantity;
        followPlan.allocationRatio = allocation.allocationRatio;

        // 更新交易数量为调整后的数量
        followPlan.quantity = allocation.adjustedQuantity;
      }
    }
  }

  /**
   * 应用固定金额分配到 ENTER 操作的跟单计划
   */
  private async applyFixedAmountAllocation(
    followPlans: FollowPlan[],
    currentPositions: Position[],
    fixedAmountPerCoin: number,
    agentId: string
  ): Promise<void> {
    const enterPlans = followPlans.filter(plan => plan.action === "ENTER");

    if (enterPlans.length === 0) {
      return;
    }

    // 获取对应的仓位信息
    const positionsForAllocation: Position[] = [];
    for (const plan of enterPlans) {
      const position = currentPositions.find(p => p.symbol === plan.symbol);
      if (position && position.margin > 0) {
        positionsForAllocation.push(position);
      }
    }

    if (positionsForAllocation.length === 0) {
      return;
    }

    // 获取可用余额
    let availableBalance: number | undefined;
    try {
      const accountInfo = await this.tradingExecutor.getAccountInfo();
      availableBalance = parseFloat(accountInfo.availableBalance);
      logDebug(`${LOGGING_CONFIG.EMOJIS.INFO} Available account balance: ${availableBalance.toFixed(2)} USDT`);
    } catch (balanceError) {
      logWarn(`${LOGGING_CONFIG.EMOJIS.WARNING} Failed to get account balance: ${balanceError instanceof Error ? balanceError.message : 'Unknown error'}`);
    }

    // 执行固定金额分配
    const allocationResult = this.capitalManager.allocateFixedMargin(
      positionsForAllocation,
      fixedAmountPerCoin,
      undefined, // 不限制总资金
      availableBalance
    );

    // 显示分配信息
    this.displayFixedAmountAllocation(allocationResult, agentId, fixedAmountPerCoin);

    // 将分配结果应用到跟单计划
    this.applyAllocationToPlans(allocationResult, enterPlans);
  }

  /**
   * 显示固定金额分配信息
   */
  private displayFixedAmountAllocation(allocationResult: CapitalAllocationResult, agentId: string, fixedAmountPerCoin: number): void {
    logDebug(`\n${LOGGING_CONFIG.EMOJIS.MONEY} Fixed Amount Allocation for ${agentId}:`);
    logDebug('==========================================');
    logDebug(`${LOGGING_CONFIG.EMOJIS.MONEY} Fixed Amount per Coin: $${fixedAmountPerCoin.toFixed(2)}`);
    logDebug(`${LOGGING_CONFIG.EMOJIS.COUNT} Positions Allocated: ${allocationResult.allocations.length}`);
    logDebug(`${LOGGING_CONFIG.EMOJIS.MONEY} Total Margin Used: $${allocationResult.totalAllocatedMargin.toFixed(2)}`);
    logDebug(`${LOGGING_CONFIG.EMOJIS.TREND_UP} Total Notional Value: $${allocationResult.totalNotionalValue.toFixed(2)}`);
    logDebug('');

    for (const allocation of allocationResult.allocations) {
      logDebug(`${allocation.symbol} - ${allocation.leverage}x leverage`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.CHART} Original Margin: $${allocation.originalMargin.toFixed(2)}`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.MONEY} Fixed Allocated Margin: $${allocation.allocatedMargin.toFixed(2)}`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.TREND_UP} Notional Value: $${allocation.notionalValue.toFixed(2)}`);
      logDebug(`   ${LOGGING_CONFIG.EMOJIS.INFO} Adjusted Quantity: ${allocation.adjustedQuantity.toFixed(4)}`);
      logDebug('');
    }

    logDebug('==========================================');
  }

  /**
   * 获取指定 agent 的历史仓位（从订单历史重建）
   * @deprecated 不再需要此方法，直接调用 rebuildLastPositionsFromHistory
   */
  getLastPositions(agentId: string, currentPositions: Position[] = []): Position[] {
    return this.rebuildLastPositionsFromHistory(agentId, currentPositions);
  }

  /**
   * 清除指定 agent 的订单历史
   * @deprecated 历史数据现在存储在 order-history.json 中
   * 如需清除，请手动编辑该文件或使用 OrderHistoryManager
   */
  clearLastPositions(agentId: string): void {
    logWarn(`⚠️ clearLastPositions is deprecated. History is now in order-history.json`);
  }

  /**
   * 清除所有历史仓位
   * @deprecated 历史数据现在存储在 order-history.json 中
   * 如需清除，请手动删除该文件
   */
  clearAllLastPositions(): void {
    logWarn(`⚠️ clearAllLastPositions is deprecated. History is now in order-history.json`);
  }
}
