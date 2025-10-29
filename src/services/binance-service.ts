import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import CryptoJS from 'crypto-js';
import ccxt, { Exchange as CcxtExchange, Order as CcxtOrder, Position as CcxtPosition } from 'ccxt';
import http from 'http';
import https from 'https';
import { PerpExchange } from './exchange/perp-exchange';
import type {
  BinanceOrder,
  StopLossOrder,
  TakeProfitOrder,
  OrderResponse,
  PositionResponse,
  UserTrade,
  ExchangeTicker,
  ExchangeAccountInfo,
  OrderSide
} from './exchange/types';
export type {
  BinanceOrder,
  StopLossOrder,
  TakeProfitOrder,
  OrderResponse,
  PositionResponse,
  UserTrade
} from './exchange/types';

export interface BinanceApiResponse<T = any> {
  code?: number;
  msg?: string;
  data?: T;
}

// Binance API通常直接返回数据，不包装在response对象中
export type BinanceDirectResponse<T> = T;

export class BinanceService implements PerpExchange {
  readonly id: string;
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string | undefined;
  private client?: AxiosInstance;
  private symbolInfoCache: Map<string, any> = new Map();
  private serverTimeOffset = 0; // 服务器时间偏移量(ms)
  private httpAgent?: http.Agent;
  private httpsAgent?: https.Agent;
  private useCcxt: boolean;
  private ccxtExchange?: CcxtExchange;
  private ccxtMarketsLoaded = false;
  private ccxtLoadPromise?: Promise<void>;
  private testnet: boolean;

  constructor(apiKey: string, apiSecret: string, testnet?: boolean, exchangeId?: string) {
    const resolvedExchange = (exchangeId || process.env.TRADING_EXCHANGE || 'binance').toLowerCase();
    this.id = resolvedExchange;
    this.useCcxt = resolvedExchange !== 'binance';

    this.apiKey = apiKey || this.resolveApiKey(resolvedExchange);
    this.apiSecret = apiSecret || this.resolveApiSecret(resolvedExchange);
    this.testnet = testnet !== undefined ? testnet : this.resolveTestnetFlag(resolvedExchange);


    if (this.useCcxt) {
      this.setupCcxtExchange();
    } else {
      this.setupBinanceClient();
    }
  }

  private resolveApiKey(exchangeId: string): string {
    const genericKey = process.env.EXCHANGE_API_KEY || '';
    if (exchangeId === 'bybit') {
      return process.env.BYBIT_API_KEY || genericKey || process.env.BINANCE_API_KEY || '';
    }
    return process.env.BINANCE_API_KEY || genericKey || '';
  }

  private resolveApiSecret(exchangeId: string): string {
    const genericSecret = process.env.EXCHANGE_API_SECRET || '';
    if (exchangeId === 'bybit') {
      return process.env.BYBIT_API_SECRET || genericSecret || process.env.BINANCE_API_SECRET || '';
    }
    return process.env.BINANCE_API_SECRET || genericSecret || '';
  }

  private resolveTestnetFlag(exchangeId: string): boolean {
    if (exchangeId === 'bybit') {
      return process.env.BYBIT_TESTNET === 'true';
    }
    return process.env.BINANCE_TESTNET === 'true';
  }

  private setupBinanceClient(): void {
    this.baseUrl = this.testnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
    });

    this.syncServerTime().catch(err => {
      console.warn('⚠️ Failed to sync server time:', err instanceof Error ? err.message : 'Unknown error');
    });
  }

  private async setupCcxtExchange(): Promise<void> {
    this.baseUrl = '';
    // const exchangeKey = this.id === 'bybit' ? 'bybit' : this.id;
    this.ccxtExchange = new ccxt.bybit({
      apiKey: this.apiKey,
      secret: this.apiSecret,
      enableRateLimit: true
    });
    const exchange = this.ccxtExchange;

    if (!exchange) {
      throw new Error(`Failed to initialise CCXT exchange for ${this.id}`);
    }

    if (this.id === 'bybit') {
      exchange.options = {
        ...exchange.options,
        defaultType: 'swap',
        defaultSubType: 'linear',
        category: 'linear',
        recvWindow: 60000,
        fetchMarkets: {
          types: ['linear']
        }
      };
      // Avoid hitting private coin info endpoint during loadMarkets on Bybit
      exchange.has = {
        ...exchange.has,
        fetchCurrencies: false
      };
    }

    if (typeof exchange.setSandboxMode === 'function') {
      exchange.setSandboxMode(!!this.testnet);
    }

    this.ccxtLoadPromise = exchange.loadMarkets()
      .then(() => {
        this.ccxtMarketsLoaded = true;
      })
      .catch(error => {
        console.log("🚀 ~ BinanceService ~ setupCcxtExchange ~ error:", error)
        console.error(`⚠️ Failed to load markets for ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
      });
  }

  private ensureCcxtExchange(): CcxtExchange {
    if (!this.ccxtExchange) {
      throw new Error(`CCXT exchange not initialized for ${this.id}`);
    }
    return this.ccxtExchange;
  }

  private async ensureCcxtMarkets(): Promise<void> {
    if (!this.ccxtExchange) {
      return;
    }
    if (this.ccxtMarketsLoaded) {
      return;
    }
    if (this.ccxtLoadPromise) {
      await this.ccxtLoadPromise;
      return;
    }
    this.ccxtLoadPromise = this.ccxtExchange.loadMarkets()
      .then(() => {
        this.ccxtMarketsLoaded = true;
      })
      .catch(error => {
        console.error(`⚠️ Failed to load markets for ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
      });
    await this.ccxtLoadPromise;
  }

  private toCcxtSymbol(symbol: string): string {
    const baseSymbol = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
    if (this.id === 'bybit') {
      return `${baseSymbol}/USDT:USDT`;
    }
    return `${baseSymbol}/USDT`;
  }

  private fromCcxtSymbol(symbol: string): string {
    if (symbol.includes(':USDT')) {
      const [base] = symbol.split('/');
      return `${base}USDT`;
    }
    if (symbol.includes('/')) {
      const [base] = symbol.split('/');
      return `${base}USDT`;
    }
    return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
  }

  private toSafeNumber(value: string | number | undefined | null): number {
    if (value === undefined || value === null) {
      return 0;
    }
    if (typeof value === 'number') {
      return value;
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private mapCcxtOrder(order: CcxtOrder): OrderResponse {
    const orderId = order.id ? Number(order.id) : Date.now();
    const side = (order.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    return {
      orderId,
      symbol: this.fromCcxtSymbol(order.symbol || ''),
      status: (order.status || 'NEW').toUpperCase(),
      clientOrderId: order.clientOrderId || '',
      price: this.toSafeNumber(order.price).toString(),
      avgPrice: this.toSafeNumber(order.average ?? order.price).toString(),
      origQty: this.toSafeNumber(order.amount).toString(),
      executedQty: this.toSafeNumber(order.filled).toString(),
      cumQty: this.toSafeNumber(order.filled).toString(),
      cumQuote: this.toSafeNumber(order.cost).toString(),
      timeInForce: (order.timeInForce || 'GTC') as any,
      type: (order.type || '').toUpperCase(),
      reduceOnly: Boolean(order.reduceOnly),
      closePosition: Boolean(order.reduceOnly),
      side,
      positionSide: side === 'SELL' ? 'SHORT' : 'LONG',
      stopPrice: this.toSafeNumber(order.stopPrice ?? order.triggerPrice).toString(),
      workingType: 'MARK_PRICE',
      priceProtect: false,
      origType: (order.type || '').toUpperCase(),
      time: order.timestamp || Date.now(),
      updateTime: order.lastTradeTimestamp || order.timestamp || Date.now(),
      info: order.info
    };
  }

  private mapCcxtPosition(position: CcxtPosition): PositionResponse {
    const sideMultiplier = position.side === 'short' ? -1 : 1;
    const rawContracts = (position as any).contracts ?? (position as any).contractSize ?? (position as any).amount;
    const contracts = this.toSafeNumber(rawContracts);
    const positionAmt = contracts * sideMultiplier;

    return {
      symbol: this.fromCcxtSymbol(position.symbol || ''),
      positionAmt: positionAmt.toString(),
      entryPrice: this.toSafeNumber(position.entryPrice).toString(),
      markPrice: this.toSafeNumber(position.markPrice ?? position.lastPrice ?? position.info?.markPrice).toString(),
      unRealizedProfit: this.toSafeNumber(position.unrealizedPnl ?? position.info?.unrealisedPnl).toString(),
      liquidationPrice: this.toSafeNumber(position.liquidationPrice ?? position.info?.liqPrice).toString(),
      leverage: this.toSafeNumber(position.leverage ?? position.info?.leverage).toString(),
      maxNotionalValue: '',
      marginType: (position.marginMode || 'cross').toUpperCase(),
      isolatedMargin: position.marginMode === 'isolated' ? this.toSafeNumber(position.info?.isolatedMargin).toString() : '0',
      isAutoAddMargin: 'false',
      positionSide: position.side === 'short' ? 'SHORT' : 'LONG',
      notional: this.toSafeNumber(position.notional ?? position.contractSize ?? 0).toString(),
      isolatedWallet: position.marginMode === 'isolated' ? this.toSafeNumber(position.info?.isolatedBalance).toString() : '0',
      updateTime: position.timestamp || Date.now()
    };
  }

  private mapCcxtAccount(balance: any): ExchangeAccountInfo {
    const usdt = balance?.USDT || balance?.USDC || {};
    let free = this.toSafeNumber(usdt.free);
    let total = this.toSafeNumber(usdt.total);
    let used = this.toSafeNumber(usdt.used);
    let totalUnrealized = this.toSafeNumber(usdt.unrealizedPnl ?? usdt.unrealisedPnl);

    // Fallback to raw balance info for unified accounts
    const info = balance?.info ?? {};
    const candidates = ([] as any[])
      .concat(info?.result?.list ?? [])
      .concat(info?.result?.balance ?? [])
      .concat(info?.list ?? []);

    const accountEntry = candidates.find(entry => entry?.accountType === 'UNIFIED')
      || candidates.find(entry => entry?.accountType === 'contract' || entry?.accountType === 'CONTRACT')
      || candidates[0];

    if (accountEntry) {
      total = total || this.toSafeNumber(accountEntry.totalWalletBalance ?? accountEntry.totalEquity ?? accountEntry.walletBalance);
      free = free || this.toSafeNumber(accountEntry.totalAvailableBalance ?? accountEntry.availableBalance ?? accountEntry.walletBalance);
      used = used || this.toSafeNumber(
        accountEntry.totalPositionInitialMargin ??
        accountEntry.totalInitialMargin ??
        accountEntry.positionMargin ??
        accountEntry.marginBalance ??
        accountEntry.totalMarginBalance
      );
      totalUnrealized = totalUnrealized || this.toSafeNumber(
        accountEntry.totalUnrealisedPnl ??
        accountEntry.totalUnrealizedPnl ??
        accountEntry.unrealisedPnl ??
        accountEntry.unrealizedPnl
      );
    }

    const response: ExchangeAccountInfo = {
      totalWalletBalance: total.toString(),
      availableBalance: free.toString(),
      totalInitialMargin: used.toString(),
      totalMaintMargin: '0',
      totalPositionInitialMargin: used.toString(),
      totalOpenOrderInitialMargin: '0',
      totalCrossWalletBalance: total.toString(),
      totalUnrealizedProfit: totalUnrealized.toString()
    };

    return response;
  }

  /**
   * Convert symbol from nof1 format (BTC) to Binance format (BTCUSDT)
   */
  public convertSymbol(symbol: string): string {
    if (this.useCcxt) {
      if (symbol.includes('/') || symbol.includes(':')) {
        return this.fromCcxtSymbol(symbol);
      }
    }
    // If symbol already ends with USDT, return as is
    if (symbol.endsWith('USDT')) {
      return symbol;
    }
    // Otherwise, append USDT
    return `${symbol}USDT`;
  }

  /**
   * Format quantity precision based on symbol
   */
  public formatQuantity(quantity: number | string, symbol: string): string {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      const ccxtSymbol = this.toCcxtSymbol(symbol);
      const amount = typeof quantity === 'string' ? parseFloat(quantity) : quantity;
      if (Number.isNaN(amount)) {
        return '0';
      }
      if (this.ccxtMarketsLoaded && exchange.markets?.[ccxtSymbol]) {
        try {
          return exchange.amountToPrecision(ccxtSymbol, amount);
        } catch (error) {
          console.warn(`⚠️ Failed to format quantity via CCXT for ${ccxtSymbol}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
      return amount.toFixed(6);
    }

    const baseSymbol = this.convertSymbol(symbol);

    // Updated precision map based on actual Binance futures API specifications
    const precisionMap: Record<string, number> = {
      'BTCUSDT': 3,      // BTC futures: 3 decimal places (min 0.001, step 0.001)
      'ETHUSDT': 3,      // ETH futures: 3 decimal places (min 0.001, step 0.001)
      'BNBUSDT': 2,      // BNB futures: 2 decimal places (min 0.01, step 0.01)
      'XRPUSDT': 1,      // XRP futures: 1 decimal place (min 0.1, step 0.1)
      'ADAUSDT': 0,      // ADA futures: 0 decimal places (min 1, step 1)
      'DOGEUSDT': 0,     // DOGE futures: 0 decimal places (min 1, step 1)
      'SOLUSDT': 2,      // SOL futures: 2 decimal places (min 0.01, step 0.01)
      'AVAXUSDT': 2,     // AVAX futures: 2 decimal places (min 0.01, step 0.01)
      'MATICUSDT': 1,    // MATIC futures: 1 decimal place (min 0.1, step 0.1)
      'DOTUSDT': 2,      // DOT futures: 2 decimal places (min 0.01, step 0.01)
      'LINKUSDT': 2,     // LINK futures: 2 decimal places (min 0.01, step 0.01)
      'UNIUSDT': 2,      // UNI futures: 2 decimal places (min 0.01, step 0.01)
    };

    const precision = precisionMap[baseSymbol] || 3; // Default to 3 decimal places

    // Convert to number if it's a string
    const quantityNum = typeof quantity === 'string' ? parseFloat(quantity) : quantity;

    // Define minimum quantities based on actual Binance futures API specifications
    const minQtyMap: Record<string, number> = {
      'BTCUSDT': 0.001,     // BTC futures min: 0.001
      'ETHUSDT': 0.001,     // ETH futures min: 0.001
      'BNBUSDT': 0.01,      // BNB futures min: 0.01
      'XRPUSDT': 0.1,       // XRP futures min: 0.1
      'ADAUSDT': 1,         // ADA futures min: 1
      'DOGEUSDT': 10,       // DOGE futures min: 10
      'SOLUSDT': 0.01,      // SOL futures min: 0.01
      'AVAXUSDT': 0.01,     // AVAX futures min: 0.01
      'MATICUSDT': 0.1,     // MATIC futures min: 0.1
      'DOTUSDT': 0.01,      // DOT futures min: 0.01
      'LINKUSDT': 0.01,     // LINK futures min: 0.01
      'UNIUSDT': 0.01,      // UNI futures min: 0.01
    };

    const minQty = minQtyMap[baseSymbol] || 0.001;

    // If quantity is too small, return minimum quantity
    if (quantityNum < minQty && quantityNum > 0) {
      console.warn(`Quantity ${quantityNum} is below minimum ${minQty} for ${baseSymbol}, using minimum`);
      return minQty.toString();
    }

    // Round to nearest valid step size
    const stepSize = minQty; // Use minQty as step size for simplicity
    const roundedQuantity = Math.floor(quantityNum / stepSize) * stepSize;

    // Ensure we don't go below minimum
    const finalQuantity = Math.max(roundedQuantity, minQty);

    // Format to correct precision - keep trailing zeros for precision requirements
    const formattedQuantity = finalQuantity.toFixed(precision);
    return formattedQuantity;
  }

  /**
   * Format price precision based on symbol
   */
  public formatPrice(price: number | string, symbol: string): string {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      const ccxtSymbol = this.toCcxtSymbol(symbol);
      const actualPrice = typeof price === 'string' ? parseFloat(price) : price;
      if (Number.isNaN(actualPrice)) {
        return '0';
      }
      if (this.ccxtMarketsLoaded && exchange.markets?.[ccxtSymbol]) {
        try {
          return exchange.priceToPrecision(ccxtSymbol, actualPrice);
        } catch (error) {
          console.warn(`⚠️ Failed to format price via CCXT for ${ccxtSymbol}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
      return actualPrice.toFixed(4);
    }

    const baseSymbol = this.convertSymbol(symbol);

    // Price precision map for stop prices and regular prices
    const pricePrecisionMap: Record<string, number> = {
      'BTCUSDT': 1,      // BTC: 1 decimal place for prices
      'ETHUSDT': 2,      // ETH: 2 decimal places for prices
      'BNBUSDT': 2,      // BNB: 2 decimal places for prices
      'ADAUSDT': 4,      // ADA: 4 decimal places for prices
      'DOGEUSDT': 5,     // DOGE: 5 decimal places for prices
      'SOLUSDT': 2,      // SOL: 2 decimal places for prices
      'AVAXUSDT': 2,     // AVAX: 2 decimal places for prices
      'MATICUSDT': 3,    // MATIC: 3 decimal places for prices
      'DOTUSDT': 2,      // DOT: 2 decimal places for prices
      'LINKUSDT': 2,     // LINK: 2 decimal places for prices
      'UNIUSDT': 2,      // UNI: 2 decimal places for prices
    };

    const precision = pricePrecisionMap[baseSymbol] || 2; // Default to 2 decimal places for prices

    // Convert to number if it's a string
    const priceNum = typeof price === 'string' ? parseFloat(price) : price;

    // Format to correct precision - keep trailing zeros for precision requirements
    const formattedPrice = priceNum.toFixed(precision);
    return formattedPrice;
  }

  /**
   * 生成币安API签名
   */
  private createSignature(queryString: string): string {
    return CryptoJS.HmacSHA256(queryString, this.apiSecret).toString(CryptoJS.enc.Hex);
  }

  /**
   * 创建带签名的请求
   */
  /**
   * 同步服务器时间
   * 公共方法,允许在遇到时间同步错误时手动重新同步
   */
  public async syncServerTime(): Promise<void> {
    if (this.useCcxt || !this.client) {
      return;
    }
    try {
      const localTime = Date.now();
      const response = await this.client.get('/fapi/v1/time');
      const serverTime = response.data.serverTime;
      this.serverTimeOffset = serverTime - localTime;
      console.log(`⏰ Server time synced. Offset: ${this.serverTimeOffset}ms`);
    } catch (error) {
      console.warn('⚠️ Failed to sync server time:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * 清理资源，关闭所有连接
   */
  public destroy(): void {
    if (this.useCcxt) {
      if (this.ccxtExchange && typeof this.ccxtExchange.close === 'function') {
        this.ccxtExchange.close();
      }
      return;
    }
    // 关闭 HTTP agents
    if (this.httpAgent) {
      this.httpAgent.destroy();
    }
    if (this.httpsAgent) {
      this.httpsAgent.destroy();
    }
  }

  /**
   * 获取调整后的时间戳
   */
  private getAdjustedTimestamp(): number {
    return Date.now() + this.serverTimeOffset;
  }

  private async makeSignedRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    params: Record<string, any> = {}
  ): Promise<T> {
    if (this.useCcxt) {
      throw new Error('Signed REST requests are not supported in CCXT mode');
    }
    if (!this.client) {
      throw new Error('HTTP client is not initialized');
    }
    try {
      const timestamp = this.getAdjustedTimestamp();
      const recvWindow = 60000; // 60秒窗口,避免时间同步问题
      const allParams: Record<string, any> = { ...params, timestamp, recvWindow };

      // 构建查询字符串
      const queryString = Object.keys(allParams)
        .sort()
        .map(key => `${key}=${encodeURIComponent(allParams[key])}`)
        .join('&');

      // 生成签名
      const signature = this.createSignature(queryString);

      const url = `${endpoint}?${queryString}&signature=${signature}`;

      const config: AxiosRequestConfig = {
        method,
        url,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      };

      const response = await this.client.request<T>(config);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const errorData = error.response.data as any;
        const errorCode = errorData?.code;
        const errorMessage = errorData?.msg || errorData?.message || error.message;
        const statusText = error.response.statusText;
        const statusCode = error.response.status;

        // Log error details for debugging
        console.error(`API Error [${errorCode || 'UNKNOWN'}]: ${errorMessage}`);
        
        // 处理时间同步错误 (-1021)
        if (errorCode === -1021) {
          console.warn('⏰ Timestamp error detected, syncing server time and retrying...');
          await this.syncServerTime();
          // 重试一次
          const retryTimestamp = this.getAdjustedTimestamp();
          const retryParams: Record<string, any> = { ...params, timestamp: retryTimestamp, recvWindow: 60000 };
          const retryQueryString = Object.keys(retryParams)
            .sort()
            .map(key => `${key}=${encodeURIComponent(retryParams[key])}`)
            .join('&');
          const retrySignature = this.createSignature(retryQueryString);
          const retryUrl = `${endpoint}?${retryQueryString}&signature=${retrySignature}`;
          const retryConfig: AxiosRequestConfig = {
            method,
            url: retryUrl,
            headers: { 'X-MBX-APIKEY': this.apiKey }
          };
          const retryResponse = await this.client.request<T>(retryConfig);
          return retryResponse.data;
        }
        
        if (errorCode === -2019) {
          console.error('💰 Margin insufficient - check available balance and existing positions');
        }

        // Maintain backward compatibility for tests - don't include error code in the thrown message
        throw new Error(`Binance API Error: ${errorMessage}`);
      }
      throw new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 创建普通请求（无需签名）
   */
  private async makePublicRequest<T>(
    endpoint: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    if (this.useCcxt) {
      throw new Error('Public REST requests are not supported in CCXT mode');
    }
    if (!this.client) {
      throw new Error('HTTP client is not initialized');
    }
    try {
      const queryString = Object.keys(params)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');

      const url = queryString ? `${endpoint}?${queryString}` : endpoint;
      const response = await this.client.get<T>(url);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const errorData = error.response.data as any;
        const errorCode = errorData?.code;
        const errorMessage = errorData?.msg || errorData?.message || error.message;
        const statusText = error.response.statusText;
        const statusCode = error.response.status;

        // Log error details for debugging
        console.error(`API Error [${errorCode || 'UNKNOWN'}]: ${errorMessage}`);
        if (errorCode === -2019) {
          console.error('💰 Margin insufficient - check available balance and existing positions');
        }

        // Maintain backward compatibility for tests - don't include error code in the thrown message
        throw new Error(`Binance API Error: ${errorMessage}`);
      }
      throw new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 获取交易所信息
   */
  async getExchangeInformation(): Promise<any> {
    if (this.useCcxt) {
      await this.ensureCcxtMarkets();
      const exchange = this.ensureCcxtExchange();
      const symbols = Object.values(exchange.markets || {}).map(market => ({
        symbol: this.fromCcxtSymbol(market.symbol),
        filters: [
          {
            filterType: 'LOT_SIZE',
            stepSize: market.limits?.amount?.min !== undefined
              ? String(market.limits.amount.min)
              : '0.001'
          }
        ]
      }));
      return { symbols };
    }
    return await this.makePublicRequest('/fapi/v1/exchangeInfo');
  }

  /**
   * 获取符号信息（带缓存）
   */
  async getSymbolInfo(symbol: string): Promise<any> {
    if (this.useCcxt) {
      await this.ensureCcxtMarkets();
      const exchange = this.ensureCcxtExchange();
      const ccxtSymbol = this.toCcxtSymbol(symbol);
      const market = exchange.markets?.[ccxtSymbol];
      if (market) {
        return {
          symbol: this.fromCcxtSymbol(market.symbol),
          filters: [
            {
              filterType: 'LOT_SIZE',
              stepSize: market.limits?.amount?.min !== undefined
                ? String(market.limits.amount.min)
                : '0.001'
            }
          ]
        };
      }
    }

    const baseSymbol = this.convertSymbol(symbol);

    // 如果缓存中有，直接返回
    if (this.symbolInfoCache.has(baseSymbol)) {
      return this.symbolInfoCache.get(baseSymbol);
    }

    // 否则获取交易所信息并找到对应符号
    try {
      const exchangeInfo = await this.getExchangeInformation();
      const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === baseSymbol);

      if (symbolInfo) {
        // 缓存符号信息
        this.symbolInfoCache.set(baseSymbol, symbolInfo);
        return symbolInfo;
      } else {
        throw new Error(`Symbol ${baseSymbol} not found in exchange information`);
      }
    } catch (error) {
      console.warn(`Failed to get symbol info for ${baseSymbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // 返回默认值
      return {
        symbol: baseSymbol,
        filters: [
          {
            filterType: 'LOT_SIZE',
            stepSize: '0.001'
          }
        ]
      };
    }
  }

  /**
   * 获取服务器时间
   */
  async getServerTime(): Promise<number> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      if (exchange.has?.fetchTime) {
        try {
          return await exchange.fetchTime() as number;
        } catch (error) {
          console.warn(`⚠️ Failed to fetch server time from ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
      return Date.now();
    }
    const response = await this.makePublicRequest<{ serverTime: number }>('/fapi/v1/time');
    return response.serverTime;
  }

  /**
   * 获取账户信息
   */
  async getAccountInfo(): Promise<any> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      try {
        const balance = await exchange.fetchBalance();
        const mapped = this.mapCcxtAccount(balance);
        return {
          ...mapped,
          availableBalance: mapped.availableBalance,
          totalWalletBalance: mapped.totalWalletBalance,
          info: balance.info
        };
      } catch (error) {
        console.warn(`⚠️ Failed to fetch account info from ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
        throw error;
      }
    }
    return await this.makeSignedRequest('/fapi/v2/account');
  }

  /**
   * 获取持仓信息
   */
  async getPositions(): Promise<PositionResponse[]> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const positions = await exchange.fetchPositions();
      return positions
        .map(position => this.mapCcxtPosition(position))
        .filter(position => Math.abs(parseFloat(position.positionAmt)) > 0);
    }
    const response = await this.makeSignedRequest<PositionResponse[]>('/fapi/v2/positionRisk');
    return response.filter((pos: PositionResponse) => parseFloat(pos.positionAmt) !== 0);
  }

  /**
   * 获取所有仓位信息(包括零仓位)
   */
  async getAllPositions(): Promise<PositionResponse[]> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const positions = await exchange.fetchPositions();
      return positions.map(position => this.mapCcxtPosition(position));
    }
    return await this.makeSignedRequest<PositionResponse[]>('/fapi/v2/positionRisk');
  }

  /**
   * 下单
   */
  async placeOrder(order: BinanceOrder): Promise<OrderResponse> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();

      const ccxtSymbol = this.toCcxtSymbol(order.symbol);
      const amount = parseFloat(this.formatQuantity(order.quantity, order.symbol));
      const price = order.price ? parseFloat(this.formatPrice(order.price, order.symbol)) : undefined;
      const isReduceOnly = order.closePosition === "true";

      const params: Record<string, any> = {};
      if (isReduceOnly) {
        params.reduceOnly = true;
        params.closeOnTrigger = true;
      }
      if (order.timeInForce) {
        params.timeInForce = order.timeInForce;
      }

      let ccxtType = 'market';
      switch (order.type) {
        case 'MARKET':
          ccxtType = 'market';
          break;
        case 'LIMIT':
          ccxtType = 'limit';
          break;
        case 'STOP':
        case 'STOP_MARKET':
          ccxtType = 'market';
          if (order.stopPrice) {
            const stop = parseFloat(this.formatPrice(order.stopPrice, order.symbol));
            params.stopPrice = stop;
            params.triggerPrice = stop;
          }
          params.type = 'stop';
          break;
        case 'TAKE_PROFIT':
        case 'TAKE_PROFIT_MARKET':
          ccxtType = 'market';
          if (order.stopPrice) {
            const tp = parseFloat(this.formatPrice(order.stopPrice, order.symbol));
            params.stopPrice = tp;
            params.triggerPrice = tp;
          }
          params.type = 'take_profit';
          break;
      }

      const ccxtOrder = await exchange.createOrder(
        ccxtSymbol,
        ccxtType,
        order.side.toLowerCase(),
        amount,
        price,
        params
      );

      return this.mapCcxtOrder(ccxtOrder);
    }

    const params: Record<string, any> = {
      symbol: this.convertSymbol(order.symbol),
      side: order.side,
      type: order.type,
    };

    // 如果使用 closePosition，则不需要 quantity
    if (order.closePosition !== "true") {
      params.quantity = this.formatQuantity(order.quantity, order.symbol);
    }

    if (order.price) params.price = this.formatPrice(order.price, order.symbol);
    if (order.stopPrice) params.stopPrice = this.formatPrice(order.stopPrice, order.symbol);
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (order.closePosition) params.closePosition = order.closePosition;

    const response = await this.makeSignedRequest<OrderResponse>('/fapi/v1/order', 'POST', params);
    return response;
  }

  /**
   * 设置杠杆
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      if (exchange.has?.setLeverage) {
        try {
          await exchange.setLeverage(leverage, this.toCcxtSymbol(symbol));
        } catch (error) {
          console.warn(`⚠️ Failed to set leverage on ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
      return;
    }
    await this.makeSignedRequest('/fapi/v1/leverage', 'POST', {
      symbol: this.convertSymbol(symbol),
      leverage: leverage.toString(),
    });
  }

  /**
   * 设置保证金模式
 * @param symbol 交易对
 * @param marginType ISOLATED(逐仓) 或 CROSSED(全仓)
 */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      if (exchange.has?.setMarginMode) {
        try {
          await exchange.setMarginMode(marginType.toLowerCase(), this.toCcxtSymbol(symbol));
        } catch (error) {
          console.warn(`⚠️ Failed to set margin mode on ${this.id}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
      return;
    }
    await this.makeSignedRequest('/fapi/v1/marginType', 'POST', {
      symbol: this.convertSymbol(symbol),
      marginType: marginType,
    });
  }

  /**
   * 取消订单
   */
  async cancelOrder(symbol: string, orderId: number | string): Promise<OrderResponse> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const ccxtOrder = await exchange.cancelOrder(
        orderId.toString(),
        this.toCcxtSymbol(symbol)
      );
      return this.mapCcxtOrder(ccxtOrder);
    }
    return await this.makeSignedRequest<OrderResponse>('/fapi/v1/order', 'DELETE', {
      symbol: this.convertSymbol(symbol),
      orderId: orderId.toString(),
    });
  }

  /**
   * 取消所有订单
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      await exchange.cancelAllOrders(this.toCcxtSymbol(symbol));
      return;
    }
    await this.makeSignedRequest('/fapi/v1/allOpenOrders', 'DELETE', {
      symbol: this.convertSymbol(symbol)
    });
  }

  /**
   * 获取订单状态
   */
  async getOrderStatus(symbol: string, orderId: number | string): Promise<OrderResponse> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const ccxtOrder = await exchange.fetchOrder(
        orderId.toString(),
        this.toCcxtSymbol(symbol)
      );
      return this.mapCcxtOrder(ccxtOrder);
    }
    return await this.makeSignedRequest<OrderResponse>('/fapi/v1/order', 'GET', {
      symbol: this.convertSymbol(symbol),
      orderId: orderId.toString(),
    });
  }

  /**
   * 获取开放订单
   */
  async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const ccxtOrders = await exchange.fetchOpenOrders(
        symbol ? this.toCcxtSymbol(symbol) : undefined
      );
      return ccxtOrders.map(order => this.mapCcxtOrder(order));
    }
    const params: Record<string, any> = {};
    if (symbol) params.symbol = this.convertSymbol(symbol);

    return await this.makeSignedRequest<OrderResponse[]>('/fapi/v1/openOrders', 'GET', params);
  }

  /**
   * 获取24小时价格变动统计
   */
  async get24hrTicker(symbol?: string): Promise<ExchangeTicker> {
    if (this.useCcxt) {
      if (!symbol) {
        throw new Error('Symbol is required when fetching ticker in CCXT mode');
      }
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();
      const ticker = await exchange.fetchTicker(this.toCcxtSymbol(symbol));
      const lastPrice = this.toSafeNumber(ticker.last ?? ticker.info?.lastPrice);
      return {
        ...ticker,
        lastPrice: lastPrice.toString()
      };
    }

    const params: Record<string, any> = {};
    if (symbol) params.symbol = this.convertSymbol(symbol);

    return await this.makePublicRequest('/fapi/v1/ticker/24hr', params);
  }

  /**
   * 获取用户成交记录
   * @param symbol 交易对 (可选)
   * @param startTime 开始时间 (可选, Unix时间戳)
   * @param endTime 结束时间 (可选, Unix时间戳)
   * @param fromId 从哪个ID开始查询 (可选, 用于分页)
   * @param limit 限制返回数量 (默认500, 最大1000)
   */
  async getUserTrades(
    symbol?: string,
    startTime?: number,
    endTime?: number,
    fromId?: number,
    limit: number = 500
  ): Promise<UserTrade[]> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();

      const ccxtSymbol = symbol ? this.toCcxtSymbol(symbol) : undefined;
      const since = startTime || undefined;
      const params: Record<string, any> = {};
      if (endTime) {
        params.endTime = endTime;
      }
      if (fromId) {
        params.fromId = fromId;
      }

      const trades = await exchange.fetchMyTrades(ccxtSymbol, since, limit, params);
      return trades.map(trade => {
        const normalizedSide = (trade.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' as const : 'BUY' as const;
        return {
          symbol: this.fromCcxtSymbol(trade.symbol || ''),
          id: trade.id ? Number(trade.id) : trade.timestamp || Date.now(),
          orderId: trade.order ? Number(trade.order) || 0 : 0,
          side: normalizedSide,
          qty: this.toSafeNumber(trade.amount).toString(),
          price: this.toSafeNumber(trade.price).toString(),
          quoteQty: this.toSafeNumber(trade.cost).toString(),
          commission: this.toSafeNumber(trade.fee?.cost).toString(),
          commissionAsset: trade.fee?.currency || 'USDT',
          realizedPnl: this.toSafeNumber((trade.info as any)?.realizedPnl).toString(),
          time: trade.timestamp || Date.now(),
          positionSide: normalizedSide === 'SELL' ? 'SHORT' : 'LONG',
          buyer: normalizedSide !== 'SELL',
          maker: (trade.takerOrMaker || '').toLowerCase() === 'maker',
          info: trade.info
        };
      });
    }

    const params: Record<string, any> = { limit };

    if (symbol) params.symbol = this.convertSymbol(symbol);
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    if (fromId) params.fromId = fromId;

    return await this.makeSignedRequest<UserTrade[]>('/fapi/v1/userTrades', 'GET', params);
  }

  /**
   * 获取指定时间范围内的所有用户成交记录
   * 注意：币安API限制只能查询最近6个月内的交易记录，且单次查询时间范围不能超过7天
   * @param startTime 开始时间
   * @param endTime 结束时间
   * @param symbol 交易对 (可选)
   */
  async getAllUserTradesInRange(
    startTime: number,
    endTime: number,
    symbol?: string
  ): Promise<UserTrade[]> {
    if (this.useCcxt) {
      const exchange = this.ensureCcxtExchange();
      await this.ensureCcxtMarkets();

      const ccxtSymbol = symbol ? this.toCcxtSymbol(symbol) : undefined;
      const allTrades: UserTrade[] = [];
      let fetchSince = startTime;
      const limit = 1000;

      while (fetchSince < endTime) {
        const trades = await exchange.fetchMyTrades(
          ccxtSymbol,
          fetchSince,
          limit,
          { endTime }
        );

        if (!trades.length) {
          break;
        }

        const mapped = trades.map(trade => {
          const normalizedSide = (trade.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' as const : 'BUY' as const;
          return {
            symbol: this.fromCcxtSymbol(trade.symbol || ''),
            id: trade.id ? Number(trade.id) : trade.timestamp || Date.now(),
            orderId: trade.order ? Number(trade.order) || 0 : 0,
            side: normalizedSide,
            qty: this.toSafeNumber(trade.amount).toString(),
            price: this.toSafeNumber(trade.price).toString(),
            quoteQty: this.toSafeNumber(trade.cost).toString(),
            commission: this.toSafeNumber(trade.fee?.cost).toString(),
            commissionAsset: trade.fee?.currency || 'USDT',
            realizedPnl: this.toSafeNumber((trade.info as any)?.realizedPnl).toString(),
            time: trade.timestamp || Date.now(),
            positionSide: normalizedSide === 'SELL' ? 'SHORT' : 'LONG',
            buyer: normalizedSide !== 'SELL',
            maker: (trade.takerOrMaker || '').toLowerCase() === 'maker',
            info: trade.info
          };
        });

        allTrades.push(...mapped);

        const lastTrade = trades[trades.length - 1];
        if (!lastTrade || !lastTrade.timestamp) {
          break;
        }
        fetchSince = lastTrade.timestamp + 1;
      }

      allTrades.sort((a, b) => a.time - b.time);
      return allTrades.filter(trade => trade.time >= startTime && trade.time <= endTime);
    }

    const allTrades: UserTrade[] = [];
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;

    // 如果时间范围超过7天，分批获取
    let currentStartTime = startTime;
    while (currentStartTime < endTime) {
      let currentEndTime = Math.min(currentStartTime + sevenDaysInMs, endTime);

      let fromId: number | undefined;
      const maxLimit = 1000; // 单次请求最大数量

      while (true) {
        const trades = await this.getUserTrades(symbol, currentStartTime, currentEndTime, fromId, maxLimit);

        if (trades.length === 0) break;

        allTrades.push(...trades);

        // 如果返回的记录数少于限制，说明已经获取完所有数据
        if (trades.length < maxLimit) break;

        // 使用最后一条记录的ID作为下一次查询的起始点
        fromId = trades[trades.length - 1].id;
      }

      // 移动到下一个7天时间段
      currentStartTime = currentEndTime;
    }

    // 按时间排序
    allTrades.sort((a, b) => a.time - b.time);

    return allTrades;
  }

  convertToOrder(tradingPlan: any): BinanceOrder {
    return {
      symbol: tradingPlan.symbol,
      side: tradingPlan.side,
      type: tradingPlan.type,
      quantity: this.formatQuantity(tradingPlan.quantity, tradingPlan.symbol),
      leverage: tradingPlan.leverage
    };
  }

  convertToBinanceOrder(tradingPlan: any): BinanceOrder {
    return this.convertToOrder(tradingPlan);
  }

  /**
   * 创建止盈订单
   */
  createTakeProfitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    takeProfitPrice: number
  ): TakeProfitOrder {
    return {
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      quantity: this.formatQuantity(quantity, symbol),
      stopPrice: this.formatPrice(takeProfitPrice, symbol),
      closePosition: "true"
    };
  }

  /**
   * 创建止损订单
   */
  createStopLossOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    stopLossPrice: number
  ): StopLossOrder {
    return {
      symbol,
      side,
      type: "STOP_MARKET",
      quantity: this.formatQuantity(quantity, symbol),
      stopPrice: this.formatPrice(stopLossPrice, symbol),
      closePosition: "true"
    };
  }

  /**
   * 计算止盈止损订单方向
   * 多头仓位：SELL止盈止损
   * 空头仓位：BUY止盈止损
   */
  private calculateStopOrderSide(positionSide: "BUY" | "SELL"): "BUY" | "SELL" {
    return positionSide === "BUY" ? "SELL" : "BUY";
  }

  /**
   * 根据position创建止盈止损订单
   */
  createStopOrdersFromPosition(position: any, positionSide: "BUY" | "SELL") {
    const orders = {
      takeProfitOrder: null as TakeProfitOrder | null,
      stopLossOrder: null as StopLossOrder | null
    };

    if (!position || !position.exit_plan) {
      return orders;
    }

    const orderSide = this.calculateStopOrderSide(positionSide);

    // 创建止盈订单
    if (position.exit_plan.profit_target > 0) {
      orders.takeProfitOrder = this.createTakeProfitOrder(
        position.symbol,
        orderSide,
        Math.abs(position.quantity),
        position.exit_plan.profit_target
      );
    }

    // 创建止损订单
    if (position.exit_plan.stop_loss > 0) {
      orders.stopLossOrder = this.createStopLossOrder(
        position.symbol,
        orderSide,
        Math.abs(position.quantity),
        position.exit_plan.stop_loss
      );
    }

    return orders;
  }
}
