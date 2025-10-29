import path from 'path';
import { FollowPlan } from '../scripts/analyze-api';
import { CommandOptions, ServiceContainer } from '../types/command';
import {
  initializeServices,
  applyConfiguration,
  printFollowPlanInfo,
  convertToTradingPlan,
  assessRiskWithTolerance,
  printRiskAssessment,
  executeTradeWithHistory
} from '../utils/command-helpers';
import { startApiServer, type ApiServerHandle } from '../server/api-server';

/**
 * 处理单个跟随计划
 */
async function processFollowPlan(
  plan: FollowPlan,
  services: ServiceContainer,
  options: CommandOptions,
  index: number
): Promise<{ executed: boolean; skipped: boolean }> {
  printFollowPlanInfo(plan, index);

  const tradingPlan = convertToTradingPlan(plan);
  const riskAssessment = assessRiskWithTolerance(
    services.riskManager,
    plan,
    tradingPlan,
    options.priceTolerance
  );

  printRiskAssessment(riskAssessment);

  if (!riskAssessment.isValid) {
    console.log(`   ❌ Risk assessment: FAILED - Trade skipped`);
    return { executed: false, skipped: true };
  }

  if (options.riskOnly) {
    console.log(`   ✅ Risk assessment: PASSED - Risk only mode`);
    return { executed: false, skipped: false };
  }

  console.log(`   ✅ Risk assessment: PASSED`);
  console.log(`   🔄 Executing trade...`);

  const result = await executeTradeWithHistory(
    services.executor,
    tradingPlan,
    plan,
    services.orderHistoryManager
  );

  return { executed: result.success, skipped: false };
}

/**
 * Follow 命令处理器
 */
export async function handleFollowCommand(agentName: string, options: CommandOptions): Promise<void> {
  const services = initializeServices(true);
  applyConfiguration(services.analyzer, options);

  let apiServer: ApiServerHandle | undefined;
  const apiPort = parseInt(process.env.API_PORT || '8080', 10);
  const apiHost = process.env.API_HOST || '0.0.0.0';
  const staticDir = process.env.DASHBOARD_DIR
    ? path.resolve(process.env.DASHBOARD_DIR)
    : path.join(process.cwd(), 'dashboard');
  try {
    apiServer = await startApiServer({
      services,
      port: apiPort,
      host: apiHost,
      staticDir
    });
  } catch (error) {
    console.error(`⚠️ Failed to start API server on http://${apiHost}:${apiPort}:`, error instanceof Error ? error.message : error);
  }

  console.log(`🤖 Starting to follow agent: ${agentName}`);

  if (options.interval) {
    console.log(`⏰ Polling interval: ${options.interval} seconds`);
    console.log('Press Ctrl+C to stop monitoring\n');
  }

  let pollingCount = 0;

  const poll = async () => {
    try {
      pollingCount++;
      if (pollingCount > 1) {
        console.log(`\n--- Poll #${pollingCount} ---`);
      }

      const followOptions = {
        totalMargin: options.totalMargin,
        fixedAmountPerCoin: options.fixedAmountPerCoin,
        profitTarget: options.profit,
        autoRefollow: options.autoRefollow,
        marginType: options.marginType || 'CROSSED'
      };
      const followPlans = await services.analyzer.followAgent(agentName, followOptions);

      if (followPlans.length === 0) {
        console.log('📋 No new actions required');
        return;
      }

      console.log(`\n📊 Follow Plans for ${agentName}:`);
      console.log('==========================');

      let executedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < followPlans.length; i++) {
        const result = await processFollowPlan(followPlans[i], services, options, i);
        if (result.executed) executedCount++;
        if (result.skipped) skippedCount++;
      }

      // 注意：不需要手动更新 lastPositions！
      // executeTradeWithHistory 已经将成功的订单保存到 order-history.json
      // 下次 followAgent 调用时会自动从 order-history.json 重建 lastPositions

      console.log(`\n🎉 Follow analysis complete!`);
      console.log(`✅ Executed: ${executedCount} trade(s)`);
      console.log(`⏸️  Skipped: ${skippedCount} trade(s) (high risk)`);

    } catch (error) {
      console.error('❌ Error during polling:', error instanceof Error ? error.message : error);
    }
  };

  // Initial poll
  await poll();

  // Set up continuous polling if interval is specified
  if (options.interval) {
    const intervalMs = parseInt(options.interval) * 1000;
    const intervalId = setInterval(poll, intervalMs);

    // Handle graceful shutdown
    const shutdown = async (signal: NodeJS.Signals) => {
      console.log(`\n\n👋 Received ${signal}. Stopping agent monitoring...`);
      clearInterval(intervalId);
      if (apiServer) {
        try {
          await apiServer.close();
          console.log('✅ API server stopped');
        } catch (error) {
          console.error('❌ Failed to stop API server:', error instanceof Error ? error.message : error);
        }
      }
      console.log('✅ Monitoring stopped gracefully');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
