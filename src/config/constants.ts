/**
 * 应用配置常量
 * 用于集中管理所有硬编码的配置值
 */

export const API_CONFIG = {
  // API 配置
  BASE_URL: process.env.NOF1_API_BASE_URL || 'https://nof1.ai/api',
  ENDPOINTS: {
    ACCOUNT_TOTALS: '/account-totals'
  },
  TIMEOUT: 30000, // 30秒超时
} as const;

export const TIME_CONFIG = {
  // 时间相关配置
  INITIAL_MARKER_TIME: new Date('2025-10-17T22:30:00.000Z'),
  HOUR_IN_MS: 1000 * 60 * 60,
  VERIFICATION_DELAY: 2000, // 2秒验证延迟
  BETWEEN_OPERATIONS_DELAY: 1000, // 1秒操作间延迟
} as const;

export enum LogLevel {
  ERROR = 0,   // 只显示错误
  WARN = 1,    // 显示警告和错误
  INFO = 2,    // 显示重要信息(默认)
  DEBUG = 3,   // 显示调试信息
  VERBOSE = 4  // 显示所有信息
}

export const LOGGING_CONFIG = {
  // 日志级别 (可通过环境变量 LOG_LEVEL 设置: ERROR, WARN, INFO, DEBUG, VERBOSE)
  LEVEL: ((): LogLevel => {
    const level = process.env.LOG_LEVEL?.toUpperCase();
    switch (level) {
      case 'ERROR': return LogLevel.ERROR;
      case 'WARN': return LogLevel.WARN;
      case 'INFO': return LogLevel.INFO;
      case 'DEBUG': return LogLevel.DEBUG;
      case 'VERBOSE': return LogLevel.VERBOSE;
      default: return LogLevel.INFO; // 默认级别
    }
  })(),
  
  // 日志配置
  EMOJIS: {
    API: '📡',
    DATA: '📊',
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    INFO: '💡',
    ROBOT: '🤖',
    TARGET: '🎯',
    TREND_UP: '📈',
    TREND_DOWN: '📉',
    CLOSING: '🔄',
    SEARCH: '🔍',
    MONEY: '💰',
    CHART: '📊',
    COUNT: '🔢',
    TIMER: '⏰',
  } as const,
} as const;

// 交易相关配置通过命令行参数控制

export const CACHE_CONFIG = {
  // 缓存配置
  CACHE_TTL: 60000, // 1分钟缓存
  MAX_CACHE_SIZE: 100, // 最大缓存条目数
} as const;

export const ENV_VARS = {
  // 环境变量名称
  BINANCE_API_KEY: 'BINANCE_API_KEY',
  BINANCE_API_SECRET: 'BINANCE_API_SECRET',
  BINANCE_TESTNET: 'BINANCE_TESTNET',
  TRADING_EXCHANGE: 'TRADING_EXCHANGE',
  EXCHANGE_API_KEY: 'EXCHANGE_API_KEY',
  EXCHANGE_API_SECRET: 'EXCHANGE_API_SECRET',
  BYBIT_API_KEY: 'BYBIT_API_KEY',
  BYBIT_API_SECRET: 'BYBIT_API_SECRET',
  BYBIT_TESTNET: 'BYBIT_TESTNET',
  NOF1_API_BASE_URL: 'NOF1_API_BASE_URL',
  TELEGRAM_ENABLED: 'TELEGRAM_ENABLED',
  TELEGRAM_API_TOKEN: 'TELEGRAM_API_TOKEN',
  TELEGRAM_CHAT_ID: 'TELEGRAM_CHAT_ID',
} as const;

// 计算当前 marker 的辅助函数
export function getCurrentLastHourlyMarker(): number {
  const now = new Date();
  const hoursSinceInitial = Math.floor(
    (now.getTime() - TIME_CONFIG.INITIAL_MARKER_TIME.getTime()) / TIME_CONFIG.HOUR_IN_MS
  );
  return hoursSinceInitial;
}

// 构建 API URL 的辅助函数
export function buildAccountTotalsUrl(marker?: number): string {
  const currentMarker = marker !== undefined ? marker : getCurrentLastHourlyMarker();
  return `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.ACCOUNT_TOTALS}?lastHourlyMarker=${currentMarker}`;
}
