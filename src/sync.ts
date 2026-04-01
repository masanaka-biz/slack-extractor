import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "dotenv";
import { SlackExtractor } from "./slack.js";
import type { SyncState, ChannelItem, ExtractionResult } from "./types.js";

config();

const OUTPUT_DIR = resolve(import.meta.dirname, "../output");
const SYNC_STATE_PATH = resolve(OUTPUT_DIR, ".sync-state.json");

/** sync-state.json の読み込み */
function loadSyncState(): SyncState {
  if (!existsSync(SYNC_STATE_PATH)) {
    return { channels: {} };
  }
  const raw = readFileSync(SYNC_STATE_PATH, "utf-8");
  return JSON.parse(raw) as SyncState;
}

/** sync-state.json の保存 */
function saveSyncState(state: SyncState): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 既存の月別JSONを読み込み */
function loadExistingMessages(filepath: string): ExtractionResult | null {
  if (!existsSync(filepath)) return null;
  const raw = readFileSync(filepath, "utf-8");
  return JSON.parse(raw) as ExtractionResult;
}

/** メッセージをマージ（ts で重複排除） */
function mergeMessages(
  existing: ChannelItem[],
  newItems: ChannelItem[]
): ChannelItem[] {
  const tsSet = new Set(existing.map((m) => m.ts));
  const merged = [...existing];

  for (const item of newItems) {
    if (!tsSet.has(item.ts)) {
      merged.push(item);
      tsSet.add(item.ts);
    }
  }

  // ts昇順でソート
  merged.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  return merged;
}

/** ChannelItem の ts から YYYY-MM ラベルを算出 */
function tsToMonthLabel(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseArgs(args: string[]): { channelNames: string[] } {
  const channelNames: string[] = [];

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`
使い方:
  npm run sync [チャンネル名...]

例:
  # 全チャンネルの差分を取得
  npm run sync

  # 特定チャンネルのみ
  npm run sync -- dev-sozo
`);
      process.exit(0);
    }
    channelNames.push(arg);
  }

  return { channelNames };
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN が .env に設定されていません");
    process.exit(1);
  }

  const { channelNames } = parseArgs(process.argv.slice(2));

  const extractor = new SlackExtractor(token);

  // チャンネル一覧取得
  console.log("チャンネル一覧を取得中...");
  const allChannels = await extractor.getChannels();
  console.log(`Botが参加しているチャンネル: ${allChannels.length}件`);

  // 対象チャンネルのフィルタ
  const channels =
    channelNames.length > 0
      ? allChannels.filter((ch) => channelNames.includes(ch.name))
      : allChannels;

  if (channels.length === 0) {
    console.error("対象チャンネルが見つかりません");
    process.exit(1);
  }

  // sync state 読み込み
  const syncState = loadSyncState();

  console.log(`\n=== 差分同期開始 ===`);
  console.log(`対象: ${channels.map((ch) => ch.name).join(", ")}\n`);

  for (const channel of channels) {
    console.log(`--- ${channel.name} ---`);

    const channelState = syncState.channels[channel.name];
    const lastTs = channelState?.last_ts;

    if (lastTs) {
      console.log(
        `  前回取得: ${channelState.last_synced_at} (ts: ${lastTs})`
      );
    } else {
      // 初回: 当月分を全量取得
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const initialTs = String(monthStart.getTime() / 1000);
      console.log(
        `  初回同期: 当月（${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}）から取得`
      );
      // lastTs を当月初日にセット（下の fetchMessagesSince で oldest として使われる）
      syncState.channels[channel.name] = {
        channel_id: channel.id,
        last_ts: initialTs,
        last_synced_at: "",
      };
    }

    const oldest = syncState.channels[channel.name].last_ts;

    // 差分メッセージ取得
    const { items, latestTs } = await extractor.fetchMessagesSince(
      channel,
      oldest
    );

    if (items.length === 0) {
      console.log(`  新規メッセージなし`);
      // タイムスタンプは更新しておく
      syncState.channels[channel.name].last_synced_at =
        new Date().toISOString();
      continue;
    }

    console.log(`  新規メッセージ: ${items.length}件`);

    // メッセージを月別に分類
    const byMonth = new Map<string, ChannelItem[]>();
    for (const item of items) {
      const monthLabel = tsToMonthLabel(item.ts);
      if (!byMonth.has(monthLabel)) {
        byMonth.set(monthLabel, []);
      }
      byMonth.get(monthLabel)!.push(item);
    }

    // チャンネルディレクトリ作成
    const channelDir = resolve(OUTPUT_DIR, channel.name);
    mkdirSync(channelDir, { recursive: true });

    // 月別ファイルにマージ
    for (const [monthLabel, monthItems] of byMonth) {
      const filepath = resolve(channelDir, `${monthLabel}.json`);
      const existing = loadExistingMessages(filepath);

      const mergedMessages = existing
        ? mergeMessages(existing.messages, monthItems)
        : monthItems;

      const threads = mergedMessages.filter((m) => m.type === "thread").length;
      const standalone = mergedMessages.filter(
        (m) => m.type === "message"
      ).length;

      const result: ExtractionResult = {
        channel,
        period: monthLabel,
        messages: mergedMessages,
        metadata: {
          extracted_at: new Date().toISOString(),
          period: monthLabel,
          total_threads: threads,
          total_standalone_messages: standalone,
          total_messages: mergedMessages.length,
        },
      };

      writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");

      const addedCount = existing
        ? mergedMessages.length - existing.messages.length
        : monthItems.length;
      console.log(
        `  → ${filepath} (+${addedCount}件, 合計: ${mergedMessages.length}件)`
      );
    }

    // sync state 更新
    syncState.channels[channel.name] = {
      channel_id: channel.id,
      last_ts: latestTs,
      last_synced_at: new Date().toISOString(),
    };
  }

  // sync state 保存
  saveSyncState(syncState);
  console.log(`\nsync state 保存: ${SYNC_STATE_PATH}`);
  console.log("完了");
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
