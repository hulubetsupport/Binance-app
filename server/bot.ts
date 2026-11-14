import type { RequestHandler } from 'express';
import { Bot, InlineKeyboard, InputFile, Keyboard, webhookCallback } from 'grammy';
import P2PCalc from '../calc.js';
import type { AppConfig } from './config.ts';
import type { Database } from './db.ts';
import { mintAdminSessionToken } from './auth.ts';
import { getPrivateImage, savePrivateImage } from './storage.ts';
import {
  attachKycGroupMessage,
  confirmOrderPayment,
  openDispute,
  releaseOrderWithPayout,
  resolveDispute,
  reviewKyc,
  saveVerifiedPhone,
  submitKyc,
} from './services/marketplace.ts';

export interface MarketplaceBot {
  bot: Bot | null;
  webhookMiddleware: RequestHandler | null;
  sendKycCardToAdminGroup(submissionId: number): Promise<void>;
  notifyOrderPaidToAdminGroup(orderId: number): Promise<void>;
  notifyOrderDisputedToAdminGroup(orderId: number, disputeId: number, reason: string): Promise<void>;
  notifyUser(telegramId: string, text: string): Promise<void>;
  setupWebhook(): Promise<void>;
}

async function setBotSession(db: Database, telegramId: string, step: string, payload: Record<string, any>) {
  await db.query(
    `INSERT INTO bot_sessions (telegram_id, step, payload_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET step = $2, payload_json = $3, updated_at = NOW()`,
    [telegramId, step, JSON.stringify(payload)]
  );
}

async function getBotSession(db: Database, telegramId: string): Promise<{ step: string; payload: Record<string, any> } | null> {
  const res = await db.query<{ step: string; payload_json: string }>(
    `SELECT step, payload_json FROM bot_sessions WHERE telegram_id = $1`,
    [telegramId]
  );
  if (res.rows.length === 0) return null;
  try {
    return { step: res.rows[0].step, payload: JSON.parse(res.rows[0].payload_json || '{}') };
  } catch {
    return { step: res.rows[0].step, payload: {} };
  }
}

async function clearBotSession(db: Database, telegramId: string) {
  await db.query(`DELETE FROM bot_sessions WHERE telegram_id = $1`, [telegramId]);
}

async function downloadTelegramFileBuffer(bot: Bot, token: string, fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file_path missing');
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download Telegram file (${resp.status})`);
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

export function createMarketplaceBot(db: Database, config: AppConfig): MarketplaceBot {
  const hasRealToken = /^\d+:[A-Za-z0-9_-]{20,}$/.test(config.botToken || '');
  if (!hasRealToken) {
    // Return safe no-op notifier when running offline / in tests without a live Telegram Bot token
    return {
      bot: null,
      webhookMiddleware: null,
      async sendKycCardToAdminGroup() {},
      async notifyOrderPaidToAdminGroup() {},
      async notifyOrderDisputedToAdminGroup() {},
      async notifyUser() {},
      async setupWebhook() {},
    };
  }

  const bot = new Bot(config.botToken);

  async function notifyUser(telegramId: string, text: string) {
    try {
      await bot.api.sendMessage(telegramId, text, { parse_mode: 'HTML' });
    } catch (err: any) {
      console.warn(`Failed to notify Telegram user ${telegramId}:`, err?.message);
    }
  }

  async function sendKycCardToAdminGroup(submissionId: number) {
    if (!config.adminGroupId) return;
    const res = await db.query(
      `SELECT k.*, u.username FROM kyc_submissions k JOIN users u ON u.id = k.user_id WHERE k.id = $1`,
      [submissionId]
    );
    if (res.rows.length === 0) return;
    const sub = res.rows[0];

    try {
      const frontImg = await getPrivateImage(db, sub.id_front_file_id);
      const selfieImg = await getPrivateImage(db, sub.selfie_file_id);
      if (frontImg && selfieImg) {
        await bot.api.sendMediaGroup(config.adminGroupId, [
          {
            type: 'photo',
            media: new InputFile(frontImg.buffer, 'id_front.jpg'),
            caption: `🪪 KYC #${sub.id} — ID Front (${sub.full_name})`,
          },
          {
            type: 'photo',
            media: new InputFile(selfieImg.buffer, 'selfie_id.jpg'),
            caption: `🤳 KYC #${sub.id} — Selfie Holding ID`,
          },
        ]);
      }

      const cardText =
        `📋 <b>New KYC Verification Request #${sub.id}</b>\n` +
        `👤 Name: <b>${sub.full_name}</b>\n` +
        `🪪 National ID: <code>${sub.national_id_number}</code>\n` +
        `📱 Phone: <code>${sub.phone_number}</code>\n` +
        `🆔 Telegram ID: <code>${sub.telegram_id}</code> ${sub.username ? `(@${sub.username})` : ''}\n` +
        `⏳ Status: <b>PENDING</b>`;

      const kb = new InlineKeyboard()
        .text('✅ Approve', `kyc:approve:${sub.id}`)
        .text('❌ Reject', `kyc:reject:${sub.id}`);

      const sent = await bot.api.sendMessage(config.adminGroupId, cardText, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
      await attachKycGroupMessage(db, sub.id, String(config.adminGroupId), sent.message_id);
    } catch (err: any) {
      console.error('Failed to send KYC card to admin group:', err?.message);
    }
  }

  async function notifyOrderPaidToAdminGroup(orderId: number) {
    if (!config.adminGroupId) return;
    const res = await db.query(
      `SELECT o.*, b.telegram_id AS buyer_tg, b.first_name AS buyer_name, s.telegram_id AS seller_tg, s.first_name AS seller_name
       FROM orders o
       JOIN users b ON b.id = o.buyer_user_id
       JOIN users s ON s.id = o.seller_user_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (res.rows.length === 0) return;
    const o = res.rows[0];

    try {
      if (o.payment_proof_file_id) {
        const img = await getPrivateImage(db, o.payment_proof_file_id);
        if (img) {
          await bot.api.sendPhoto(config.adminGroupId, new InputFile(img.buffer, 'payment_proof.jpg'), {
            caption: `🧾 Payment Proof for Order ${o.order_code} | Ref: ${o.payment_ref}`,
          });
        }
      }
      if (o.payout_profile_file_id) {
        const pImg = await getPrivateImage(db, o.payout_profile_file_id);
        if (pImg) {
          await bot.api.sendPhoto(config.adminGroupId, new InputFile(pImg.buffer, 'payout_profile.jpg'), {
            caption: `🎯 Receiver ${o.payout_provider} Profile (${o.payout_account_id} · ${o.payout_account_name})`,
          });
        }
      }

      const text =
        `💳 <b>Order Marked PAID (${o.order_code})</b>\n` +
        `💵 ETB Total: <b>${P2PCalc.formatSantim(o.etb_total_santim)} ETB</b> (${o.payment_method})\n` +
        `🧾 Payment Ref: <code>${o.payment_ref || '-'}</code>\n` +
        `🪙 Gross: <b>${P2PCalc.formatMicroUsdt(o.gross_micro_usdt, 2)} USDT</b>\n` +
        `💰 Fee (${o.commission_percent}%): <b>${P2PCalc.formatMicroUsdt(o.fee_micro_usdt, 2)} USDT</b>\n` +
        `📤 Net Payout: <b>${P2PCalc.formatMicroUsdt(o.net_micro_usdt, 2)} USDT</b>\n` +
        `🎯 Receiver Payout: <b>${o.payout_provider || '-'}</b> <code>${o.payout_account_id || '-'}</code> (${o.payout_account_name || '-'})\n` +
        `👤 Buyer: ${o.buyer_name} (<code>${o.buyer_tg}</code>)\n` +
        `👤 Seller: ${o.seller_name} (<code>${o.seller_tg}</code>)`;

      const kb = new InlineKeyboard()
        .text('✅ Confirm Payment', `order:confirm:${o.id}`)
        .text('⚠️ Dispute', `order:dispute:${o.id}`)
        .row()
        .text('💸 Paid out (Attach Screenshot)', `order:paidout:${o.id}`);

      const msg = await bot.api.sendMessage(config.adminGroupId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
      await db.query(
        `UPDATE orders SET admin_group_chat_id = $1, admin_group_message_id = $2 WHERE id = $3`,
        [String(config.adminGroupId), msg.message_id, o.id]
      );
    } catch (err: any) {
      console.error('Failed to notify order paid to admin group:', err?.message);
    }
  }

  async function notifyOrderDisputedToAdminGroup(orderId: number, disputeId: number, reason: string) {
    if (!config.adminGroupId) return;
    const res = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    if (res.rows.length === 0) return;
    const o = res.rows[0];
    const kb = new InlineKeyboard()
      .text('✅ Release to Receiver', `dispute:release:${disputeId}`)
      .text('↩️ Refund to Seller', `dispute:refund:${disputeId}`);
    try {
      await bot.api.sendMessage(
        config.adminGroupId,
        `🚨 <b>DISPUTE OPENED (#${disputeId}) on ${o.order_code}</b>\n` +
          `Order is FROZEN.\nReason: ${reason}\n` +
          `Gross: <b>${P2PCalc.formatMicroUsdt(o.gross_micro_usdt, 2)} USDT</b> | ETB: <b>${P2PCalc.formatSantim(o.etb_total_santim)} ETB</b>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch (err: any) {
      console.error('Failed to notify dispute:', err?.message);
    }
  }

  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const uRes = await db.query(`SELECT * FROM users WHERE telegram_id = $1`, [tgId]);
    const user = uRes.rows[0];

    if (!user || !user.phone_verified) {
      const contactKb = new Keyboard()
        .requestContact('📱 Share Phone Number / ስልክ ቁጥር ያጋሩ')
        .oneTime()
        .resized();
      await ctx.reply(
        `🇪🇹 <b>እንኳን ወደ EthioP2P USDT Marketplace በደህና መጡ!</b>\n` +
          `Welcome to EthioP2P USDT Marketplace.\n\n` +
          `ለመቀጠል እባክዎ ከታች ያለውን ቁልፍ በመጫን ስልክ ቁጥርዎን ያጋሩ።\n` +
          `Please share your phone contact using the button below to begin KYC verification.`,
        { parse_mode: 'HTML', reply_markup: contactKb }
      );
      return;
    }

    if (user.kyc_status === 'NONE' || user.kyc_status === 'REJECTED') {
      await setBotSession(db, tgId, 'KYC_FULL_NAME', {});
      await ctx.reply(
        `🪪 <b>KYC Verification / የማንነት ማረጋገጫ</b>\n` +
          (user.kyc_status === 'REJECTED' ? `Previous submission was rejected. Let's resubmit.\n\n` : '\n') +
          `Step 1/4: እባክዎ <b>ሙሉ ስምዎን</b> (በመታወቂያው ላይ እንዳለው) ይጻፉ።\nPlease send your <b>Full Name</b> as shown on your National ID:`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (user.kyc_status === 'PENDING') {
      await ctx.reply(
        `⏳ የእርስዎ KYC ማረጋገጫ በአድሚን እየታየ ነው።\nYour KYC submission is currently <b>PENDING</b> review.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const appUrl = config.miniAppOrigins[0] || config.appUrl;
    const kb = new InlineKeyboard().webApp('🚀 Open P2P Mini App / መተግበሪያውን ክፈት', appUrl);
    await ctx.reply(
      `✅ <b>KYC ተረጋግጧል (APPROVED)</b>\nYou are verified to trade up to 500 USDT/day.\n\nOpen the P2P Marketplace Mini App below:`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.command('kyc', async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const uRes = await db.query(`SELECT * FROM users WHERE telegram_id = $1`, [tgId]);
    const user = uRes.rows[0];
    if (!user || !user.phone_verified) {
      const contactKb = new Keyboard()
        .requestContact('📱 Share Phone Number / ስልክ ቁጥር ያጋሩ')
        .oneTime()
        .resized();
      await ctx.reply('Please share your own phone contact first:', { reply_markup: contactKb });
      return;
    }
    if (user.kyc_status === 'APPROVED') {
      await ctx.reply('✅ Your KYC is already APPROVED.');
      return;
    }
    if (user.kyc_status === 'PENDING') {
      await ctx.reply('⏳ Your KYC is already PENDING review.');
      return;
    }
    await setBotSession(db, tgId, 'KYC_FULL_NAME', {});
    await ctx.reply('Step 1/4: Please enter your Full Name (ሙሉ ስምዎን ያስገቡ):');
  });

  bot.command('admin', async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    if (!config.adminIds.has(tgId)) {
      await ctx.reply('⛔ Unauthorized: Admin access only.');
      return;
    }
    const token = mintAdminSessionToken(tgId, config.botToken);
    const adminBase = (config.miniAppOrigins[0] || config.appUrl) + '/admin.html';
    await ctx.reply(
      `🔐 <b>Admin Console Access</b>\n\nOpen Admin Page:\n${adminBase}#token=${token}\n\n(Valid for 12 hours)`,
      { parse_mode: 'HTML' }
    );
  });

  bot.on('message:contact', async (ctx) => {
    if (!ctx.from || !ctx.message?.contact) return;
    const contact = ctx.message.contact;
    // Security rule: Accept ONLY if contact.user_id == from.id
    if (!contact.user_id || contact.user_id !== ctx.from.id) {
      await ctx.reply(
        `⛔ <b>የራስዎን ስልክ ቁጥር ብቻ ያጋሩ!</b>\nPlease share your OWN phone number using the button (forwarded contacts are rejected).`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const user = await saveVerifiedPhone(db, String(ctx.from.id), contact.phone_number, {
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
      username: ctx.from.username,
    });

    if (user.kyc_status === 'APPROVED') {
      await ctx.reply('✅ Phone updated! Your KYC is already approved.');
      return;
    }

    await setBotSession(db, String(ctx.from.id), 'KYC_FULL_NAME', {});
    await ctx.reply(
      `✅ ስልክ ቁጥር ተረጋግጧል: <code>${contact.phone_number}</code>\n\n` +
        `Step 1/4: እባክዎ <b>ሙሉ ስምዎን</b> (በመታወቂያው ላይ እንዳለው) ይጻፉ።\n` +
        `Please enter your <b>Full Name</b>:`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
    );
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.from) return;
    const adminId = String(ctx.from.id);
    if (!config.adminIds.has(adminId)) {
      await ctx.answerCallbackQuery({ text: '⛔ Only authorized ADMIN_IDS can perform this action.', show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data;
    const adminTag = ctx.from.username ? `@${ctx.from.username}` : `ID:${adminId}`;
    const decidedAt = new Date().toISOString();

    try {
      if (data.startsWith('kyc:approve:')) {
        const subId = parseInt(data.split(':')[2], 10);
        const result = await reviewKyc(db, { submissionId: subId, decision: 'APPROVED', adminId });
        await ctx.answerCallbackQuery({ text: result.alreadyDecided ? 'Already approved' : 'KYC Approved!' });
        try {
          await ctx.editMessageText(
            `✅ <b>KYC #${subId} APPROVED</b>\n` +
              `👤 Name: <b>${result.submission.full_name}</b>\n` +
              `🆔 User ID: <code>${result.submission.telegram_id}</code>\n` +
              `🛡 Decided by: ${adminTag} at ${decidedAt}`,
            { parse_mode: 'HTML' }
          );
        } catch {}
        if (!result.alreadyDecided) {
          await notifyUser(
            result.submission.telegram_id,
            `🎉 <b>የእርስዎ KYC ማረጋገጫ ጸድቋል! (APPROVED)</b>\nYour KYC is approved. You can now post ads and trade up to 500 USDT/day.`
          );
        }
        return;
      }

      if (data.startsWith('kyc:reject:')) {
        const subId = parseInt(data.split(':')[2], 10);
        const chatId = String(ctx.callbackQuery.message?.chat.id || config.adminGroupId);
        const msgId = ctx.callbackQuery.message?.message_id || 0;
        await setBotSession(db, adminId, 'ADMIN_REJECT_KYC', { subId, chatId, msgId });
        await ctx.answerCallbackQuery({ text: 'Reply with rejection reason' });
        await ctx.reply(
          `📝 ${adminTag}, please reply to this message with the <b>rejection reason</b> for KYC #${subId}:`,
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (data.startsWith('order:confirm:')) {
        const orderId = parseInt(data.split(':')[2], 10);
        const res = await confirmOrderPayment(db, { orderId, adminId });
        await ctx.answerCallbackQuery({ text: res.alreadyConfirmed ? 'Already confirmed' : 'Payment confirmed!' });
        const kb = new InlineKeyboard().text('💸 Paid out (Attach Screenshot)', `order:paidout:${orderId}`);
        try {
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text || `Order #${orderId}`}\n\n✅ Payment confirmed by ${adminTag} at ${decidedAt}`,
            { reply_markup: kb }
          );
        } catch {}
        return;
      }

      if (data.startsWith('order:dispute:')) {
        const orderId = parseInt(data.split(':')[2], 10);
        const oRes = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
        if (oRes.rows.length === 0) {
          await ctx.answerCallbackQuery({ text: 'Order not found' });
          return;
        }
        const order = oRes.rows[0];
        const disp = await openDispute(db, {
          orderId,
          openedByUserId: order.seller_user_id,
          isAdmin: true,
          adminId,
          reason: `Dispute flagged by admin ${adminTag} in group`,
        });
        await ctx.answerCallbackQuery({ text: 'Order frozen as DISPUTED' });
        await notifyOrderDisputedToAdminGroup(orderId, disp.dispute.id, disp.dispute.reason);
        return;
      }

      if (data.startsWith('order:paidout:')) {
        const orderId = parseInt(data.split(':')[2], 10);
        const chatId = String(ctx.callbackQuery.message?.chat.id || config.adminGroupId);
        const msgId = ctx.callbackQuery.message?.message_id || 0;
        await setBotSession(db, adminId, 'ADMIN_PAYOUT_PROOF', { orderId, chatId, msgId });
        await ctx.answerCallbackQuery({ text: 'Send payout screenshot photo' });
        await ctx.reply(
          `📸 ${adminTag}, please reply to this message with the <b>Binance Pay / Bybit payout screenshot photo</b> (optional caption = payout ref) for Order #${orderId}:`,
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (data.startsWith('dispute:release:')) {
        const disputeId = parseInt(data.split(':')[2], 10);
        const dRes = await db.query(`SELECT order_id FROM disputes WHERE id = $1`, [disputeId]);
        if (dRes.rows.length === 0) {
          await ctx.answerCallbackQuery({ text: 'Dispute not found' });
          return;
        }
        const chatId = String(ctx.callbackQuery.message?.chat.id || config.adminGroupId);
        const msgId = ctx.callbackQuery.message?.message_id || 0;
        await setBotSession(db, adminId, 'ADMIN_DISPUTE_RELEASE_PROOF', {
          disputeId,
          orderId: dRes.rows[0].order_id,
          chatId,
          msgId,
        });
        await ctx.answerCallbackQuery({ text: 'Send payout proof photo to release' });
        await ctx.reply(
          `📸 ${adminTag}, send the <b>payout screenshot photo</b> to resolve Dispute #${disputeId} with RELEASE:`,
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (data.startsWith('dispute:refund:')) {
        const disputeId = parseInt(data.split(':')[2], 10);
        await resolveDispute(db, config, {
          disputeId,
          adminId,
          resolution: 'RESOLVED_REFUND',
          note: `Refunded by ${adminTag} in admin group`,
        });
        await ctx.answerCallbackQuery({ text: 'Dispute resolved: Refunded to seller' });
        try {
          await ctx.editMessageText(
            `↩️ <b>Dispute #${disputeId} RESOLVED_REFUND</b> by ${adminTag} at ${decidedAt}`,
            { parse_mode: 'HTML' }
          );
        } catch {}
        return;
      }
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: err?.message || 'Action failed', show_alert: true });
    }
  });

  bot.on('message:photo', async (ctx) => {
    if (!ctx.from || !ctx.message?.photo) return;
    const tgId = String(ctx.from.id);
    const session = await getBotSession(db, tgId);
    if (!session) return;

    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const buf = await downloadTelegramFileBuffer(bot, config.botToken, largest.file_id);

      if (session.step === 'KYC_ID_FRONT') {
        const uRes = await db.query(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
        const userId = uRes.rows[0]?.id || null;
        const saved = await savePrivateImage(db, { ownerUserId: userId, purpose: 'KYC_ID_FRONT', buffer: buf });
        await setBotSession(db, tgId, 'KYC_SELFIE', {
          ...session.payload,
          idFrontFileId: saved.fileId,
        });
        await ctx.reply(
          `✅ ID front photo saved privately.\n\n` +
            `Step 4/4: እባክዎ <b>መታወቂያውን በእጅዎ ይዘው የተነሱትን ሴልፊ ፎቶ</b> ይላኩ።\n` +
            `Please send a <b>Selfie holding your National ID</b>:`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (session.step === 'KYC_SELFIE') {
        const uRes = await db.query(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
        const userId = uRes.rows[0]?.id;
        if (!userId) return;
        const saved = await savePrivateImage(db, { ownerUserId: userId, purpose: 'KYC_SELFIE', buffer: buf });
        const sub = await submitKyc(db, {
          userId,
          telegramId: tgId,
          fullName: session.payload.fullName,
          nationalIdNumber: session.payload.nationalIdNumber,
          idFrontFileId: session.payload.idFrontFileId,
          selfieFileId: saved.fileId,
        });
        await clearBotSession(db, tgId);
        await ctx.reply(
          `📩 <b>KYC Submission #${sub.id} Received!</b>\n` +
            `የእርስዎ KYC ሰነድ ተልኳል። አድሚን ሲያረጋግጥ መልእክት ይደርስዎታል።\nStatus: <b>PENDING</b>`,
          { parse_mode: 'HTML' }
        );
        await sendKycCardToAdminGroup(sub.id);
        return;
      }

      if (session.step === 'ADMIN_PAYOUT_PROOF' && config.adminIds.has(tgId)) {
        const saved = await savePrivateImage(db, { ownerUserId: null, purpose: 'ORDER_PAYOUT_PROOF', buffer: buf });
        const { orderId, chatId, msgId } = session.payload;
        const payoutRef = (ctx.message.caption || `TG_PAYOUT_${Date.now()}`).trim();
        const res = await releaseOrderWithPayout(db, {
          orderId,
          adminId: tgId,
          payoutRef,
          payoutProofFileId: saved.fileId,
        });
        await clearBotSession(db, tgId);
        const adminTag = ctx.from.username ? `@${ctx.from.username}` : `ID:${tgId}`;
        if (chatId && msgId) {
          try {
            await bot.api.editMessageText(
              chatId,
              msgId,
              `✅ <b>Order ${res.order.order_code} RELEASED (Paid Out)</b>\n` +
                `📤 Net: ${P2PCalc.formatMicroUsdt(res.order.net_micro_usdt, 2)} USDT\n` +
                `💰 Fee: ${P2PCalc.formatMicroUsdt(res.order.fee_micro_usdt, 2)} USDT\n` +
                `🧾 Ref: <code>${payoutRef}</code>\n` +
                `🛡 Released by: ${adminTag} at ${new Date().toISOString()}`,
              { parse_mode: 'HTML' }
            );
          } catch {}
        }
        await ctx.reply(`✅ Order ${res.order.order_code} marked RELEASED!`);
        const parties = await db.query(
          `SELECT b.telegram_id AS buyer_tg, s.telegram_id AS seller_tg FROM orders o
           JOIN users b ON b.id = o.buyer_user_id JOIN users s ON s.id = o.seller_user_id WHERE o.id = $1`,
          [orderId]
        );
        if (parties.rows[0]) {
          await notifyUser(
            parties.rows[0].buyer_tg,
            `🎉 Order <b>${res.order.order_code}</b> RELEASED! ${P2PCalc.formatMicroUsdt(res.order.net_micro_usdt, 2)} USDT sent to ${res.order.payout_provider} (${res.order.payout_account_id}).`
          );
          await notifyUser(
            parties.rows[0].seller_tg,
            `✅ Order <b>${res.order.order_code}</b> completed & released.`
          );
        }
        return;
      }

      if (session.step === 'ADMIN_DISPUTE_RELEASE_PROOF' && config.adminIds.has(tgId)) {
        const saved = await savePrivateImage(db, { ownerUserId: null, purpose: 'DISPUTE_PAYOUT_PROOF', buffer: buf });
        const { disputeId } = session.payload;
        const payoutRef = (ctx.message.caption || `DISPUTE_PAYOUT_${Date.now()}`).trim();
        await resolveDispute(db, config, {
          disputeId,
          adminId: tgId,
          resolution: 'RESOLVED_RELEASE',
          note: `Released by admin ${tgId}`,
          payoutRef,
          payoutProofFileId: saved.fileId,
        });
        await clearBotSession(db, tgId);
        await ctx.reply(`✅ Dispute #${disputeId} resolved with RELEASE.`);
      }
    } catch (err: any) {
      await ctx.reply(`⚠️ Error processing image: ${err?.message || 'Invalid image'}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!ctx.from || !ctx.message?.text) return;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    const tgId = String(ctx.from.id);
    const session = await getBotSession(db, tgId);
    if (!session) return;

    if (session.step === 'KYC_FULL_NAME') {
      if (text.length < 3) {
        await ctx.reply('Please enter your full name (minimum 3 characters):');
        return;
      }
      await setBotSession(db, tgId, 'KYC_NATIONAL_ID', { ...session.payload, fullName: text });
      await ctx.reply(
        `Step 2/4: እባክዎ <b>የብሔራዊ መታወቂያ ቁጥርዎን</b> (National ID Number) ይጻፉ።\nPlease enter your <b>National ID Number</b>:`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (session.step === 'KYC_NATIONAL_ID') {
      if (text.length < 4) {
        await ctx.reply('Please enter a valid National ID number:');
        return;
      }
      await setBotSession(db, tgId, 'KYC_ID_FRONT', { ...session.payload, nationalIdNumber: text });
      await ctx.reply(
        `Step 3/4: እባክዎ <b>የመታወቂያዎን የፊት ገጽ ፎቶ</b> ይላኩ።\nPlease send a clear photo of the <b>Front of your National ID</b>:`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (session.step === 'ADMIN_REJECT_KYC' && config.adminIds.has(tgId)) {
      const { subId, chatId, msgId } = session.payload;
      try {
        const result = await reviewKyc(db, {
          submissionId: subId,
          decision: 'REJECTED',
          reason: text,
          adminId: tgId,
        });
        await clearBotSession(db, tgId);
        const adminTag = ctx.from.username ? `@${ctx.from.username}` : `ID:${tgId}`;
        const decidedAt = new Date().toISOString();
        if (chatId && msgId) {
          try {
            await bot.api.editMessageText(
              chatId,
              msgId,
              `❌ <b>KYC #${subId} REJECTED</b>\n` +
                `👤 Name: <b>${result.submission.full_name}</b>\n` +
                `📝 Reason: ${text}\n` +
                `🛡 Decided by: ${adminTag} at ${decidedAt}`,
              { parse_mode: 'HTML' }
            );
          } catch {}
        }
        await ctx.reply(`❌ KYC #${subId} rejected and user notified.`);
        await notifyUser(
          result.submission.telegram_id,
          `❌ <b>የእርስዎ KYC ማረጋገጫ ተቀባይነት አላገኘም (REJECTED)</b>\nReason / ምክንያት: ${text}\n\nYou may resubmit using /kyc.`
        );
      } catch (err: any) {
        await ctx.reply(`⚠️ Failed to reject KYC: ${err?.message}`);
      }
    }
  });

  const webhookMiddleware = webhookCallback(bot, 'express', {
    secretToken: config.webhookSecretToken || undefined,
  });

  return {
    bot,
    webhookMiddleware,
    sendKycCardToAdminGroup,
    notifyOrderPaidToAdminGroup,
    notifyOrderDisputedToAdminGroup,
    notifyUser,
    async setupWebhook() {
      if (!config.appUrl || config.appUrl.includes('localhost')) return;
      const webhookUrl = `${config.appUrl}/webhook/telegram`;
      try {
        await bot.api.setWebhook(webhookUrl, {
          secret_token: config.webhookSecretToken || undefined,
        });
        console.log(`🤖 grammY webhook configured: ${webhookUrl}`);
      } catch (err: any) {
        console.warn('grammY setWebhook warning:', err?.message);
      }
    },
  };
}
