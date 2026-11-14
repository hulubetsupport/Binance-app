export interface OrderCalculationResult {
  grossMicro: number;
  feeMicro: number;
  netMicro: number;
  priceSantim: number;
  etbTotalSantim: number;
  commissionPercent: number;
  grossMicroStr: string;
  feeMicroStr: string;
  netMicroStr: string;
  priceSantimStr: string;
  etbTotalSantimStr: string;
  grossUsdt: string;
  feeUsdt: string;
  netUsdt: string;
  priceEtb: string;
  etbTotal: string;
}

export interface OrderCalculationParams {
  usdtInput?: string | number | bigint;
  priceEtbInput?: string | number | bigint;
  grossMicro?: number | bigint;
  priceSantim?: number | bigint;
  commissionPercent?: number;
}

export interface PriceGuardBounds {
  minSantim: number;
  maxSantim: number;
  minEtb: string;
  maxEtb: string;
}

declare const P2PCalc: {
  MICRO_PER_USDT: number;
  SANTIM_PER_ETB: number;
  parseUsdtToMicro(input: string | number | bigint): bigint;
  parseEtbToSantim(input: string | number | bigint): bigint;
  formatMicroUsdt(micro: string | number | bigint, minDecimals?: number): string;
  formatSantim(santim: string | number | bigint): string;
  calculateCommissionMicro(grossMicro: string | number | bigint, commissionPercent: number): bigint;
  calculateEtbTotalSantim(grossMicro: string | number | bigint, priceSantim: string | number | bigint): bigint;
  calculateOrder(params: OrderCalculationParams): OrderCalculationResult;
  isPriceWithinGuard(priceSantim: string | number | bigint, referenceSantim: string | number | bigint, maxDeviationPercent?: number): boolean;
  getPriceGuardBounds(referenceSantim: string | number | bigint, maxDeviationPercent?: number): PriceGuardBounds;
};

export default P2PCalc;
