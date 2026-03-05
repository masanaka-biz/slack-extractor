import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { config } from "dotenv";
import { SlackExtractor } from "./slack.js";

config();

const OUTPUT_DIR = resolve(import.meta.dirname, "../output");

function printUsage() {
  console.log(`
使い方:
  npx tsx src/index.ts --from 2024-01 --to 2025-03 [チャンネル名...]

オプション:
  --from YYYY-MM   取得開始月（必須）
  --to   YYYY-MM   取得終了月（必須）

例:
  # 2024年1月〜2025年3月の全チャンネル
  npx tsx src/index.ts --from 2024-01 --to 2025-03

  # 2025年3月のみ、特定チャンネル
  npx tsx src/index.ts --from 2025-03 --to 2025-03 dev-sozo

  # 2024年4月〜2024年6月、複数チャンネル
  npx tsx src/index.ts --from 2024-04 --to 2024-06 dev-sozo dev-general
`);
}

function parseArgs(args: string[]) {
  let from: string | undefined;
  let to: string | undefined;
  const channelNames: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      from = args[++i];
    } else if (args[i] === "--to" && args[i + 1]) {
      to = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else {
      channelNames.push(args[i]);
    }
  }

  if (!from || !to) {
    console.error("--from と --to は必須です\n");
    printUsage();
    process.exit(1);
  }

  const datePattern = /^\d{4}-\d{2}$/;
  if (!datePattern.test(from) || !datePattern.test(to)) {
    console.error("日付は YYYY-MM 形式で指定してください（例: 2024-01）\n");
    process.exit(1);
  }

  if (from > to) {
    console.error("--from は --to より前の月を指定してください\n");
    process.exit(1);
  }

  return { from, to, channelNames };
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN が .env に設定されていません");
    process.exit(1);
  }

  const { from, to, channelNames } = parseArgs(process.argv.slice(2));

  const extractor = new SlackExtractor(token);

  // チャンネル一覧取得
  console.log("チャンネル一覧を取得中...");
  const allChannels = await extractor.getChannels();
  console.log(`Botが参加しているチャンネル: ${allChannels.length}件`);

  for (const ch of allChannels) {
    console.log(`  - ${ch.name} (${ch.id})`);
  }

  // 対象チャンネルのフィルタ
  const channels =
    channelNames.length > 0
      ? allChannels.filter((ch) => channelNames.includes(ch.name))
      : allChannels;

  if (channels.length === 0) {
    console.error("対象チャンネルが見つかりません");
    process.exit(1);
  }

  // 月単位の期間リストを生成
  const monthlyRanges = SlackExtractor.generateMonthlyRanges(from, to);

  console.log(`\n抽出対象: ${channels.map((ch) => ch.name).join(", ")}`);
  console.log(`期間: ${from} 〜 ${to}（${monthlyRanges.length}ヶ月）\n`);

  // チャンネルごと × 月ごとに抽出
  for (const channel of channels) {
    console.log(`=== ${channel.name} ===`);

    // チャンネルごとのディレクトリ作成
    const channelDir = resolve(OUTPUT_DIR, channel.name);
    mkdirSync(channelDir, { recursive: true });

    for (const range of monthlyRanges) {
      const result = await extractor.extractChannel(channel, range);

      // メッセージが0件の月はスキップ
      if (result.messages.length === 0) {
        console.log(`  [${channel.name}] ${range.label} メッセージなし、スキップ`);
        continue;
      }

      // JSON保存: output/チャンネル名/YYYY-MM.json
      const filename = `${range.label}.json`;
      const filepath = resolve(channelDir, filename);
      writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");

      console.log(
        `  → ${filepath} (スレッド: ${result.metadata.total_threads}, 単独: ${result.metadata.total_standalone_messages}, 計: ${result.metadata.total_messages})`
      );
    }

    console.log("");
  }

  console.log("完了");
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
