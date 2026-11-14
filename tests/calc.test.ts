import test from 'node:test';
import assert from 'node:assert/strict';
import P2PCalc from '../calc.js';

test('3 USDT at 194.00 ETB with 3% commission', () => {
  const res = P2PCalc.calculateOrder({
    usdtInput: '3',
    priceEtbInput: '194.00',
    commissionPercent: 3,
  });
  assert.equal(res.grossMicro, 3_000_000);
  assert.equal(res.feeMicro, 90_000); // 0.09 USDT
  assert.equal(res.netMicro, 2_910_000); // 2.91 USDT
  assert.equal(res.etbTotalSantim, 58_200); // 582.00 ETB
  assert.equal(res.grossUsdt, '3.00');
  assert.equal(res.feeUsdt, '0.09');
  assert.equal(res.netUsdt, '2.91');
  assert.equal(res.etbTotal, '582.00');
});

test('100 USDT at 194.50 ETB with 3% commission', () => {
  const res = P2PCalc.calculateOrder({
    usdtInput: '100',
    priceEtbInput: '194.50',
    commissionPercent: 3,
  });
  assert.equal(res.grossMicro, 100_000_000);
  assert.equal(res.feeMicro, 3_000_000);
  assert.equal(res.netMicro, 97_000_000);
  assert.equal(res.etbTotalSantim, 1_945_000); // 19450.00 ETB
  assert.equal(res.grossUsdt, '100.00');
  assert.equal(res.feeUsdt, '3.00');
  assert.equal(res.netUsdt, '97.00');
  assert.equal(res.etbTotal, '19450.00');
});

test('1800 USDT at 195.25 ETB with 3% commission', () => {
  const res = P2PCalc.calculateOrder({
    usdtInput: '1800',
    priceEtbInput: '195.25',
    commissionPercent: 3,
  });
  assert.equal(res.grossMicro, 1_800_000_000);
  assert.equal(res.feeMicro, 54_000_000); // 54.00 USDT
  assert.equal(res.netMicro, 1_746_000_000); // 1746.00 USDT
  assert.equal(res.etbTotalSantim, 35_145_000); // 351,450.00 ETB
  assert.equal(res.feeUsdt, '54.00');
  assert.equal(res.netUsdt, '1746.00');
  assert.equal(res.etbTotal, '351450.00');
});

test('round_half_up to 2 decimals on exact .005 boundary (1.50 USDT -> 0.05 fee)', () => {
  const res1 = P2PCalc.calculateOrder({
    usdtInput: '1.50',
    priceEtbInput: '194.00',
    commissionPercent: 3,
  });
  // 1.50 * 3% = 0.045 -> rounds half-up to 0.05 USDT (50,000 micro)
  assert.equal(res1.feeMicro, 50_000);
  assert.equal(res1.netMicro, 1_450_000);
  assert.equal(res1.feeUsdt, '0.05');
  assert.equal(res1.netUsdt, '1.45');

  const res2 = P2PCalc.calculateOrder({
    usdtInput: '0.50',
    priceEtbInput: '194.00',
    commissionPercent: 3,
  });
  // 0.50 * 3% = 0.015 -> rounds half-up to 0.02 USDT (20,000 micro)
  assert.equal(res2.feeMicro, 20_000);
  assert.equal(res2.netMicro, 480_000);
});

test('round_half_up just below and above .005 boundary (1.16 vs 1.17 USDT)', () => {
  const below = P2PCalc.calculateOrder({
    usdtInput: '1.16',
    priceEtbInput: '194.00',
    commissionPercent: 3,
  });
  // 1.16 * 3% = 0.0348 -> 0.03
  assert.equal(below.feeMicro, 30_000);
  assert.equal(below.netMicro, 1_130_000);

  const above = P2PCalc.calculateOrder({
    usdtInput: '1.17',
    priceEtbInput: '194.00',
    commissionPercent: 3,
  });
  // 1.17 * 3% = 0.0351 -> 0.04
  assert.equal(above.feeMicro, 40_000);
  assert.equal(above.netMicro, 1_130_000);
});

test('odd 6-decimal micro-USDT and ETB santim half-up rounding', () => {
  const res = P2PCalc.calculateOrder({
    usdtInput: '12.345678',
    priceEtbInput: '194.33',
    commissionPercent: 3,
  });
  // 12.345678 * 3% = 0.37037034 -> 0.37 USDT (370,000 micro)
  assert.equal(res.grossMicro, 12_345_678);
  assert.equal(res.feeMicro, 370_000);
  assert.equal(res.netMicro, 11_975_678);
  // ETB: 12.345678 * 19433 = 239913.560574 santim -> rounds half-up to 239914 santim = 2399.14 ETB
  assert.equal(res.etbTotalSantim, 239_914);
  assert.equal(res.etbTotal, '2399.14');
});

test('custom commission percent & zero commission', () => {
  const res5 = P2PCalc.calculateOrder({
    usdtInput: '33.33',
    priceEtbInput: '190.00',
    commissionPercent: 5,
  });
  // 33.33 * 5% = 1.6665 -> 1.67
  assert.equal(res5.feeMicro, 1_670_000);
  assert.equal(res5.netMicro, 31_660_000);

  const res0 = P2PCalc.calculateOrder({
    usdtInput: '33.33',
    priceEtbInput: '190.00',
    commissionPercent: 0,
  });
  assert.equal(res0.feeMicro, 0);
  assert.equal(res0.netMicro, 33_330_000);
});

test('price guard checks ±10% integer bounds accurately', () => {
  const ref = 19400n; // 194.00 ETB
  assert.equal(P2PCalc.isPriceWithinGuard(17460n, ref, 10), true); // exact -10%
  assert.equal(P2PCalc.isPriceWithinGuard(21340n, ref, 10), true); // exact +10%
  assert.equal(P2PCalc.isPriceWithinGuard(17459n, ref, 10), false);
  assert.equal(P2PCalc.isPriceWithinGuard(21341n, ref, 10), false);
});

test('rejects invalid decimal precision, negative, or zero amounts', () => {
  assert.throws(() => P2PCalc.parseUsdtToMicro('1.1234567'));
  assert.throws(() => P2PCalc.parseEtbToSantim('100.123'));
  assert.throws(() => P2PCalc.parseUsdtToMicro('-5'));
  assert.throws(() => P2PCalc.calculateOrder({ usdtInput: '0', priceEtbInput: '194.00', commissionPercent: 3 }));
});
