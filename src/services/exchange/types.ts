export type OrderSide = 'BUY' | 'SELL';

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP'
  | 'TAKE_PROFIT'
  | 'TAKE_PROFIT_MARKET'
  | 'STOP_MARKET';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface ExchangeOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  leverage: number;
  price?: string;
  stopPrice?: string;
  timeInForce?: TimeInForce;
  closePosition?: string;
}

export interface ExchangeOrder {
  orderId: number | string;
  symbol: string;
  status: string;
  clientOrderId?: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQty?: string;
  cumQuote?: string;
  timeInForce?: TimeInForce | string;
  type: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  side: OrderSide;
  positionSide?: string;
  stopPrice?: string;
  workingType?: string;
  priceProtect?: boolean;
  origType?: string;
  time?: number;
  updateTime?: number;
  info?: Record<string, unknown>;
}

export interface ExchangePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue?: string;
  marginType?: string;
  isolatedMargin?: string;
  isAutoAddMargin?: string;
  positionSide?: string;
  notional?: string;
  isolatedWallet?: string;
  updateTime?: number;
}

export interface ExchangeAccountInfo {
  totalWalletBalance: string;
  availableBalance: string;
  totalInitialMargin?: string;
  totalMaintMargin?: string;
  totalPositionInitialMargin?: string;
  totalOpenOrderInitialMargin?: string;
  totalCrossWalletBalance?: string;
  [key: string]: unknown;
}

export interface ExchangeTicker {
  lastPrice: string;
  [key: string]: unknown;
}

export interface StopLossOrder {
  symbol: string;
  side: OrderSide;
  type: 'STOP_MARKET' | 'STOP';
  quantity: string;
  stopPrice: string;
  closePosition?: string;
}

export interface TakeProfitOrder {
  symbol: string;
  side: OrderSide;
  type: 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';
  quantity: string;
  stopPrice: string;
  closePosition?: string;
}

export interface UserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: OrderSide;
  qty: string;
  price: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  time: number;
  positionSide: string;
  buyer: boolean;
  maker: boolean;
  info?: Record<string, unknown>;
}

// Backward compatible aliases for existing imports
export type BinanceOrder = ExchangeOrderRequest;
export type OrderResponse = ExchangeOrder;
export type PositionResponse = ExchangePosition;
