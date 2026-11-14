import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.ts';
import { createDatabase } from '../server/db.ts';
import { createExpressApp } from '../server/app.ts';
import { mintTelegramInitData, verifyTelegramInitData } from '../server/auth.ts';
import { expireOverdueOrders } from '../server/services/marketplace.ts';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function startTestServer(app: any): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test('Telegram WebApp initData HMAC verification rejects tampering & expiry', () => {
  const token = 'test_bot_token_123456';
  const now = 1700000000;
  const initData = mintTelegramInitData({ id: '9001', first_name: 'Abebe', username: 'abebe' }, token, now);

  const verified = verifyTelegramInitData(initData, token, 3600, now + 100);
  assert.equal(verified.id, '9001');
  assert.equal(verified.first_name, 'Abebe');

  // Expired
  assert.throws(() => verifyTelegramInitData(initData, token, 3600, now + 4000));

  // Tampered user id
  const tampered = initData.replace('9001', '9002');
  assert.throws(() => verifyTelegramInitData(tampered, token, 3600, now + 100));
});

test('Full Phase 1-4 marketplace integration: auth, KYC, deposit matching, ads, 15m timer, payout release, commission, disputes & auto-suspend', async () => {
  const config = loadConfig();
  config.botToken = 'integration_test_bot_token';
  config.adminIds = new Set(['100001']);
  config.commissionPercent = 3;

  const db = await createDatabase(config, { forceInMemory: true, seedDemo: true });
  const { app } = createExpressApp(db, config);
  const srv = await startTestServer(app);

  try {
    const adminInit = mintTelegramInitData({ id: '100001', first_name: 'Admin', username: 'admin' }, config.botToken);
    const sellerInit = mintTelegramInitData({ id: '200001', first_name: 'Abebe', last_name: 'Kebede', username: 'abebe_crypto' }, config.botToken);
    const buyerInit = mintTelegramInitData({ id: '200002', first_name: 'Selam', last_name: 'Tadesse', username: 'selam_trader' }, config.botToken);
    const unverifiedInit = mintTelegramInitData({ id: '200003', first_name: 'Dawit', last_name: 'Mekonnen', username: 'new_user_et' }, config.botToken);

    // 1. Unauthenticated call is rejected (401)
    const noAuth = await fetch(`${srv.baseUrl}/api/me`);
    assert.equal(noAuth.status, 401);

    // 2. Unverified user cannot post ads or trade
    const unvAd = await fetch(`${srv.baseUrl}/api/ads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({
        direction: 'BUY',
        usdtAmount: '10',
        priceEtb: '194.00',
        paymentMethods: ['Telebirr'],
      }),
    });
    assert.equal(unvAd.status, 403);

    // 3. Unverified user verifies phone + submits KYC -> Admin approves -> user becomes APPROVED
    const phoneRes = await fetch(`${srv.baseUrl}/api/kyc/verify-phone-dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({ phoneNumber: '+251944556677' }),
    });
    assert.equal(phoneRes.status, 200);

    const kycRes = await fetch(`${srv.baseUrl}/api/kyc/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({
        fullName: 'Dawit Mekonnen',
        nationalIdNumber: 'ET-990011',
        idFrontBase64: TINY_PNG_DATA_URL,
        selfieBase64: TINY_PNG_DATA_URL,
      }),
    });
    assert.equal(kycRes.status, 201);
    const kycJson: any = await kycRes.json();

    // Private file cannot be fetched without auth!
    const privNoAuth = await fetch(`${srv.baseUrl}/api/files/${kycJson.submission.id_front_file_id}`);
    assert.equal(privNoAuth.status, 403);

    // Admin approves KYC
    const revRes = await fetch(`${srv.baseUrl}/api/admin/kyc/${kycJson.submission.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
      body: JSON.stringify({ decision: 'APPROVED' }),
    });
    assert.equal(revRes.status, 200);

    // 4. Deposit matching (TRC20 unique amount)
    const depRes = await fetch(`${srv.baseUrl}/api/deposits/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({ network: 'TRC20', usdtAmount: '50' }),
    });
    assert.equal(depRes.status, 201);
    const depJson: any = await depRes.json();
    assert.ok(depJson.intent.uniqueUsdt.startsWith('50.'));
    assert.ok(depJson.intent.wrongNetworkWarning.includes('TRC20'));

    const matchRes = await fetch(`${srv.baseUrl}/api/admin/deposits/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
      body: JSON.stringify({ intentId: depJson.intent.id, txHash: '0xtron_tx_hash_unique_001' }),
    });
    assert.equal(matchRes.status, 200);

    // 5. Ad tab filtering bug fix: SELL tab shows ONLY SELL ads; BUY tab shows ONLY BUY ads
    const sellAdsRes = await fetch(`${srv.baseUrl}/api/ads?direction=SELL`, {
      headers: { 'X-Telegram-Init-Data': buyerInit },
    });
    const sellAdsJson: any = await sellAdsRes.json();
    assert.ok(sellAdsJson.ads.length >= 1);
    assert.ok(sellAdsJson.ads.every((a: any) => a.direction === 'SELL'));

    const buyAdsRes = await fetch(`${srv.baseUrl}/api/ads?direction=BUY`, {
      headers: { 'X-Telegram-Init-Data': sellerInit },
    });
    const buyAdsJson: any = await buyAdsRes.json();
    assert.ok(buyAdsJson.ads.length >= 1);
    assert.ok(buyAdsJson.ads.every((a: any) => a.direction === 'BUY'));

    // 6. Price guard rejects >10% away from 194.00 reference rate
    const badPriceAd = await fetch(`${srv.baseUrl}/api/ads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({
        direction: 'SELL',
        usdtAmount: '20',
        priceEtb: '250.00',
        paymentMethods: ['Telebirr'],
      }),
    });
    assert.equal(badPriceAd.status, 400);

    // Valid SELL ad locks USDT
    const goodAdRes = await fetch(`${srv.baseUrl}/api/ads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': unverifiedInit },
      body: JSON.stringify({
        direction: 'SELL',
        usdtAmount: '20',
        priceEtb: '195.00',
        minOrderUsdt: '3',
        maxOrderUsdt: '20',
        paymentMethods: ['Telebirr'],
      }),
    });
    assert.equal(goodAdRes.status, 201);
    const goodAdJson: any = await goodAdRes.json();

    // 7. Create order -> verify server recomputes calc.js and ignores client totals
    const orderRes = await fetch(`${srv.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': buyerInit },
      body: JSON.stringify({
        adId: goodAdJson.ad.id,
        usdtAmount: '10',
        paymentMethod: 'Telebirr',
        payoutProvider: 'BINANCE_PAY',
        payoutAccountId: '392268780',
        payoutAccountName: 'Selam Tadesse',
        payoutProfileBase64: TINY_PNG_DATA_URL,
        // Attempt to tamper fee/total
        feeMicroUsdt: 0,
        etbTotalSantim: 100,
      }),
    });
    assert.equal(orderRes.status, 201);
    const orderJson: any = await orderRes.json();
    assert.equal(orderJson.order.grossUsdt, '10.00');
    assert.equal(orderJson.order.feeUsdt, '0.30');
    assert.equal(orderJson.order.netUsdt, '9.70');
    assert.equal(orderJson.order.etbTotal, '1950.00');
    assert.equal(orderJson.order.status, 'AWAITING_PAYMENT');

    // Mark paid -> Admin confirm -> Admin Paid out -> RELEASED -> Commission recorded!
    const markPaidRes = await fetch(`${srv.baseUrl}/api/orders/${orderJson.order.id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': buyerInit },
      body: JSON.stringify({ paymentRef: 'TLB-998877', paymentProofBase64: TINY_PNG_DATA_URL }),
    });
    assert.equal(markPaidRes.status, 200);
    const markedJson: any = await markPaidRes.json();
    assert.equal(markedJson.order.status, 'PAID_MARKED');

    const paidOutRes = await fetch(`${srv.baseUrl}/api/admin/orders/${orderJson.order.id}/paid-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
      body: JSON.stringify({ payoutRef: 'BPAY-554433', payoutProofBase64: TINY_PNG_DATA_URL }),
    });
    assert.equal(paidOutRes.status, 200);
    const releasedJson: any = await paidOutRes.json();
    assert.equal(releasedJson.order.status, 'RELEASED');

    // Verify commission recorded in commissions table
    const auditRes = await fetch(`${srv.baseUrl}/api/admin/audit-log`, {
      headers: { 'X-Telegram-Init-Data': adminInit },
    });
    const auditJson: any = await auditRes.json();
    assert.equal(auditJson.commissions.length, 1);
    assert.equal(auditJson.commissions[0].feeUsdt, '0.30');

    // 8. Expiry worker expires overdue order and records ZERO commission
    const expOrderRes = await fetch(`${srv.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': buyerInit },
      body: JSON.stringify({
        adId: goodAdJson.ad.id,
        usdtAmount: '5',
        paymentMethod: 'Telebirr',
      }),
    });
    assert.equal(expOrderRes.status, 201);
    const expOrderJson: any = await expOrderRes.json();
    const expiredList = await expireOverdueOrders(db, new Date(Date.now() + 20 * 60 * 1000));
    assert.equal(expiredList.length, 1);
    assert.equal(expiredList[0].status, 'EXPIRED');

    // Commission count is still 1 (never recorded on expire!)
    const auditAfterExp: any = await (
      await fetch(`${srv.baseUrl}/api/admin/audit-log`, { headers: { 'X-Telegram-Init-Data': adminInit } })
    ).json();
    assert.equal(auditAfterExp.commissions.length, 1);

    // 9. Daily limit enforcement (500 USDT/day)
    const bigOrderRes = await fetch(`${srv.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': buyerInit },
      body: JSON.stringify({
        adId: sellAdsJson.ads[0].id,
        usdtAmount: '495',
        paymentMethod: 'Telebirr',
      }),
    });
    // Buyer already traded 10 + 5 = 15 USDT today -> 15 + 495 = 510 > 500 -> rejected!
    assert.equal(bigOrderRes.status, 403);

    // 10. Dispute freezes order, and 3 dispute losses auto-suspend user
    await fetch(`${srv.baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
      body: JSON.stringify({ maxDisputesBeforeSuspend: 2 }),
    });

    for (let i = 0; i < 2; i++) {
      const dOrd = await (
        await fetch(`${srv.baseUrl}/api/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': buyerInit },
          body: JSON.stringify({
            adId: sellAdsJson.ads[0].id,
            usdtAmount: '3',
            paymentMethod: 'Telebirr',
            payoutProvider: 'BYBIT_UID',
            payoutAccountId: `BYB-${i}`,
            payoutAccountName: 'Selam Tadesse',
            payoutProfileBase64: TINY_PNG_DATA_URL,
          }),
        })
      ).json() as any;

      const dispRes = await fetch(`${srv.baseUrl}/api/orders/${dOrd.order.id}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': sellerInit },
        body: JSON.stringify({ reason: `Buyer did not pay #${i}` }),
      });
      assert.equal(dispRes.status, 200);
      const dispJson: any = await dispRes.json();
      assert.equal(dispJson.order.status, 'DISPUTED');

      const resolveRes = await fetch(`${srv.baseUrl}/api/admin/disputes/${dispJson.dispute.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
        body: JSON.stringify({ resolution: 'RESOLVED_REFUND', note: 'Refunded to seller' }),
      });
      assert.equal(resolveRes.status, 200);
    }

    // Buyer lost 2 disputes (threshold = 2) -> should now be auto-suspended!
    const buyerMeAfter: any = await (
      await fetch(`${srv.baseUrl}/api/me`, { headers: { 'X-Telegram-Init-Data': buyerInit } })
    ).json();
    assert.equal(buyerMeAfter.user.isSuspended, true);
    assert.equal(buyerMeAfter.user.disputeLosses, 2);
  } finally {
    await srv.close();
    await db.close();
  }
});
