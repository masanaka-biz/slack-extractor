import { WebClient } from "@slack/web-api";
import type {
  ChannelInfo,
  ChannelItem,
  DateRange,
  SlackMessage,
  SlackThread,
  ExtractionResult,
  SyncState,
  SyncChannelState,
} from "./types.js";

export class SlackExtractor {
  private client: WebClient;
  private userCache: Map<string, string> = new Map();

  constructor(token: string) {
    this.client = new WebClient(token);
  }

  /** Botが参加しているチャンネル一覧を取得 */
  async getChannels(): Promise<ChannelInfo[]> {
    const channels: ChannelInfo[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      for (const ch of result.channels ?? []) {
        if (ch.id && ch.name && ch.is_member) {
          channels.push({ id: ch.id, name: ch.name });
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  }

  /** ユーザーIDから表示名を取得（キャッシュ付き） */
  private async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    try {
      const result = await this.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  /** タイムスタンプを日付文字列に変換 */
  private tsToDate(ts: string): string {
    return new Date(parseFloat(ts) * 1000).toISOString().split("T")[0];
  }

  /** タイムスタンプからパーマリンクを生成 */
  private buildPermalink(channelId: string, ts: string): string {
    const tsClean = ts.replace(".", "");
    return `https://app.slack.com/archives/${channelId}/p${tsClean}`;
  }

  /** メッセージをSlackMessage型に変換 */
  private async toSlackMessage(msg: {
    user?: string;
    text?: string;
    ts?: string;
    bot_id?: string;
    subtype?: string;
  }): Promise<SlackMessage | null> {
    // Bot投稿を除外
    if (msg.bot_id || msg.subtype === "bot_message") {
      return null;
    }

    const user = msg.user ? await this.resolveUser(msg.user) : "unknown";
    return {
      type: "message" as const,
      user,
      text: msg.text ?? "",
      ts: msg.ts ?? "",
      date: msg.ts ? this.tsToDate(msg.ts) : "",
    };
  }

  /** スレッドの返信を取得 */
  private async getThreadReplies(
    channelId: string,
    threadTs: string
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    let oldest: string | undefined;
    let hasMore = false;

    do {
      const params: {
        channel: string;
        ts: string;
        limit: number;
        cursor?: string;
        oldest?: string;
      } = {
        channel: channelId,
        ts: threadTs,
        limit: 200,
      };

      if (cursor) {
        params.cursor = cursor;
      } else if (oldest) {
        // next_cursorが返されない場合、oldestで続きを取得
        params.oldest = oldest;
      }

      const result = await this.client.conversations.replies(params);
      const resultMessages = result.messages ?? [];

      for (const msg of resultMessages) {
        // oldest指定時、親メッセージや既取得メッセージを重複追加しない
        if (oldest && msg.ts && parseFloat(msg.ts) <= parseFloat(oldest)) {
          continue;
        }

        const slackMsg = await this.toSlackMessage(msg);
        if (slackMsg) {
          messages.push(slackMsg);
        }
      }

      // 最後のメッセージのtsを記録（フォールバック用）
      if (resultMessages.length > 0) {
        const lastTs = resultMessages[resultMessages.length - 1].ts;
        if (lastTs) {
          oldest = lastTs;
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      hasMore = result.has_more ?? false;
    } while (cursor || hasMore);

    return messages;
  }

  /** 月単位の期間リストを生成 */
  static generateMonthlyRanges(from: string, to: string): DateRange[] {
    const ranges: DateRange[] = [];
    const [fromYear, fromMonth] = from.split("-").map(Number);
    const [toYear, toMonth] = to.split("-").map(Number);

    let year = fromYear;
    let month = fromMonth;

    while (year < toYear || (year === toYear && month <= toMonth)) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 1); // 翌月1日

      const label = `${year}-${String(month).padStart(2, "0")}`;
      ranges.push({
        oldest: String(start.getTime() / 1000),
        latest: String(end.getTime() / 1000),
        label,
      });

      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }

    return ranges;
  }

  /** チャンネルの差分メッセージを取得（oldest以降の新規メッセージ） */
  async fetchMessagesSince(
    channel: ChannelInfo,
    oldest?: string
  ): Promise<{ items: ChannelItem[]; latestTs: string }> {
    const items: ChannelItem[] = [];
    let latestTs = oldest ?? "0";
    let cursor: string | undefined;
    let totalMessages = 0;

    do {
      const params: {
        channel: string;
        limit: number;
        cursor?: string;
        oldest?: string;
      } = {
        channel: channel.id,
        limit: 200,
        cursor,
      };

      if (oldest) {
        params.oldest = oldest;
      }

      const result = await this.client.conversations.history(params);

      for (const msg of result.messages ?? []) {
        totalMessages++;

        if (msg.bot_id || msg.subtype === "bot_message") continue;

        // 最新のtsを追跡
        if (msg.ts && parseFloat(msg.ts) > parseFloat(latestTs)) {
          latestTs = msg.ts;
        }

        const replyCount = msg.reply_count ?? 0;

        if (replyCount > 0 && msg.ts) {
          const replies = await this.getThreadReplies(channel.id, msg.ts);
          const parentUser = msg.user
            ? await this.resolveUser(msg.user)
            : "unknown";

          items.push({
            type: "thread",
            thread_ts: msg.ts,
            ts: msg.ts,
            date: this.tsToDate(msg.ts),
            parent_message: msg.text ?? "",
            parent_user: parentUser,
            reply_count: replyCount,
            replies,
            permalink: this.buildPermalink(channel.id, msg.ts),
          });
        } else {
          const slackMsg = await this.toSlackMessage(msg);
          if (slackMsg) {
            items.push(slackMsg);
          }
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      process.stdout.write(
        `\r  [${channel.name}] 差分取得中... ${totalMessages}件処理`
      );
    } while (cursor);

    console.log("");

    // ts昇順でソート
    items.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    return { items, latestTs };
  }

  /** チャンネルの指定期間のメッセージ・スレッドを取得 */
  async extractChannel(
    channel: ChannelInfo,
    dateRange: DateRange
  ): Promise<ExtractionResult> {
    console.log(
      `  [${channel.name}] ${dateRange.label} メッセージ取得中...`
    );

    const items: ChannelItem[] = [];
    let totalThreads = 0;
    let totalStandalone = 0;
    let totalMessages = 0;
    let cursor: string | undefined;

    // チャンネルのメッセージ一覧を取得（期間指定）
    do {
      const result = await this.client.conversations.history({
        channel: channel.id,
        oldest: dateRange.oldest,
        latest: dateRange.latest,
        limit: 200,
        cursor,
      });

      for (const msg of result.messages ?? []) {
        totalMessages++;

        // Bot投稿を除外
        if (msg.bot_id || msg.subtype === "bot_message") {
          continue;
        }

        const replyCount = msg.reply_count ?? 0;

        if (replyCount > 0 && msg.ts) {
          // スレッドの返信を取得
          const replies = await this.getThreadReplies(channel.id, msg.ts);
          const parentUser = msg.user
            ? await this.resolveUser(msg.user)
            : "unknown";

          items.push({
            type: "thread",
            thread_ts: msg.ts,
            ts: msg.ts,
            date: this.tsToDate(msg.ts),
            parent_message: msg.text ?? "",
            parent_user: parentUser,
            reply_count: replyCount,
            replies,
            permalink: this.buildPermalink(channel.id, msg.ts),
          });
          totalThreads++;
        } else {
          // スレッドなしの単独メッセージ
          const slackMsg = await this.toSlackMessage(msg);
          if (slackMsg) {
            items.push(slackMsg);
            totalStandalone++;
          }
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;

      // 進捗表示
      process.stdout.write(
        `\r  [${channel.name}] ${dateRange.label} スレッド: ${totalThreads}, 単独: ${totalStandalone}, 処理済み: ${totalMessages}`
      );
    } while (cursor);

    console.log(""); // 改行

    // ts昇順でソート（時系列順）
    items.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    return {
      channel,
      period: dateRange.label,
      messages: items,
      metadata: {
        extracted_at: new Date().toISOString(),
        period: dateRange.label,
        total_threads: totalThreads,
        total_standalone_messages: totalStandalone,
        total_messages: totalMessages,
      },
    };
  }
}
