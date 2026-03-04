export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  date: string;
}

export interface SlackThread {
  thread_ts: string;
  date: string;
  parent_message: string;
  parent_user: string;
  reply_count: number;
  messages: SlackMessage[];
  permalink: string;
}

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
  threads: SlackThread[];
  standalone_messages: SlackMessage[];
  metadata: {
    extracted_at: string;
    period: string;
    total_threads: number;
    total_standalone_messages: number;
    total_messages: number;
  };
}
