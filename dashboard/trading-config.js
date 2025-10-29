const TRADING_CONFIG = {
  initialAssetValue: 140,
  initialAssetValueCurrency: 'USDT',
  baseDate: '2025-10-25T00:00:00+08:00',
  baseDateDisplay: '2025-10-29',
  appName: 'DeepSeek Chat V3.1',
  appTitle: 'Bybit 交易数据监控面板',
  display: {
    dateTextPrefix: '自',
    dateTextSuffix: '以来'
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TRADING_CONFIG;
} else {
  window.TRADING_CONFIG = TRADING_CONFIG;
}
