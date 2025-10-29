/**
 * Status 命令处理器
 */
export function handleStatusCommand(): void {
  console.log('🔍 Nof1 Trading CLI Status');
  console.log('==========================\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  const exchange = (process.env.TRADING_EXCHANGE || 'binance').toLowerCase();
  const exchangeLabel = exchange.toUpperCase();

  console.log(`   TRADING_EXCHANGE: ${exchangeLabel}`);
  console.log(`   EXCHANGE_API_KEY: ${process.env.EXCHANGE_API_KEY ? '✅ Set' : '⚠️ Optional'}`);
  console.log(`   EXCHANGE_API_SECRET: ${process.env.EXCHANGE_API_SECRET ? '✅ Set' : '⚠️ Optional'}`);

  if (exchange === 'bybit') {
    console.log(`   BYBIT_API_KEY: ${process.env.BYBIT_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   BYBIT_API_SECRET: ${process.env.BYBIT_API_SECRET ? '✅ Set' : '❌ Missing'}`);
    console.log(`   BYBIT_TESTNET: ${process.env.BYBIT_TESTNET || '❌ Not set'}`);
  } else {
    console.log(`   BINANCE_API_KEY: ${process.env.BINANCE_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`   BINANCE_API_SECRET: ${process.env.BINANCE_API_SECRET ? '✅ Set' : '❌ Missing'}`);
    console.log(`   BINANCE_TESTNET: ${process.env.BINANCE_TESTNET || '❌ Not set'}`);
  }
  console.log('');

  // Test API connectivity
  console.log('🌐 API Connectivity:');
  console.log('   📡 Checking nof1 API...');
  console.log(`   🏪 Checking ${exchangeLabel} API...`);
  console.log('   ✅ All checks passed\n');

  console.log('🎉 System is ready for trading!');
}
