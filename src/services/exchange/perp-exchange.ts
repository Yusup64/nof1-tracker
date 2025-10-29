import {
  ExchangeOrderRequest,
  ExchangeOrder,
  ExchangePosition,
  ExchangeTicker,
  StopLossOrder,
  TakeProfitOrder,
  UserTrade,
  ExchangeAccountInfo
} from './types';

export interface PerpExchange {
  readonly id: string;

  initialize?(): Promise<void>;

  convertSymbol(symbol: string): string;
  formatQuantity(quantity: number | string, symbol: string): string;
  formatPrice(price: number | string, symbol: string): string;

  getServerTime(): Promise<number>;
  getAccountInfo(): Promise<ExchangeAccountInfo>;
  getPositions(): Promise<ExchangePosition[]>;
  getAllPositions(): Promise<ExchangePosition[]>;

  placeOrder(order: ExchangeOrderRequest): Promise<ExchangeOrder>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void>;
  cancelOrder(symbol: string, orderId: number | string): Promise<ExchangeOrder>;
  cancelAllOrders(symbol: string): Promise<void>;
  getOrderStatus(symbol: string, orderId: number | string): Promise<ExchangeOrder>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;

  get24hrTicker(symbol: string): Promise<ExchangeTicker>;

  getUserTrades(
    symbol: string | undefined,
    startTime: number,
    endTime: number,
    fromId?: number,
    limit?: number
  ): Promise<UserTrade[]>;

  getAllUserTradesInRange(
    startTime: number,
    endTime: number,
    symbol?: string
  ): Promise<UserTrade[]>;

  convertToOrder(tradingPlan: any): ExchangeOrderRequest;
  createStopOrdersFromPosition(position: any, positionSide: 'BUY' | 'SELL'): {
    takeProfitOrder: TakeProfitOrder | null;
    stopLossOrder: StopLossOrder | null;
  };

  destroy(): void;
}
