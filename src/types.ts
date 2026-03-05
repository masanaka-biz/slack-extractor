export interface SlackMessage {
  type: "message";
  user: string;
  text: string;
  ts: string;
  date: string;
}

export interface SlackThread {
  type: "thread";
  thread_ts: string;
  ts: string;
  date: string;
  parent_message: string;
  parent_user: string;
  reply_count: number;
  replies: SlackMessage[];
  permalink: string;
}

export type ChannelItem = SlackMessage | SlackThread;

export interface ChannelInfo {
  id: string;
  name: string;
}

export interface DateRange {
  oldest: string; // Unix timestamp
  latest: string; // Unix timestamp
  label: string; // "2025-03" のような表示用ラベル
}

export interface ExtractionResult {
  channel: ChannelInfo;
  period: string;
  messages: ChannelItem[];
  metadata: {
    extracted_at: string;
    period: string;
    total_threads: number;
    total_standalone_messages: number;
    total_messages: number;
  };
}
