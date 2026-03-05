# slack-extractor

Slack チャンネルのメッセージとスレッドを月単位で JSON ファイルに抽出するCLIツール。

## 概要

Slack Bot Token を使って、Bot が参加しているチャンネルからメッセージを取得し、チャンネル名/月ごとに構造化された JSON として保存します。

主な特徴:

- 月単位（YYYY-MM）での期間指定
- チャンネル名によるフィルタリング（省略時は全参加チャンネルが対象）
- スレッドの返信を含む完全な会話の抽出
- Bot 投稿の自動除外
- ユーザーIDを表示名に自動解決（キャッシュ付き）
- 各スレッドへのパーマリンク生成

## セットアップ

### 1. Slack App を作成

1. https://api.slack.com/apps にアクセス
2. **「Create New App」** をクリック
3. **「From scratch」** を選択
4. App名（例: `slack-extractor`）とワークスペースを選んで作成

### 2. Bot Token Scopes を設定

左メニューの **「OAuth & Permissions」** を開き、**「Bot Token Scopes」** に以下を追加:

| スコープ | 用途 |
|---|---|
| `channels:history` | パブリックチャンネルのメッセージ取得 |
| `channels:read` | チャンネル一覧の取得 |
| `groups:history` | プライベートチャンネルのメッセージ取得 |
| `groups:read` | プライベートチャンネル一覧の取得 |
| `users:read` | ユーザー表示名の取得 |

### 3. ワークスペースにインストール

1. 左メニューの **「Install App」** を開く
2. **「Install to Workspace」** をクリック
3. 権限を確認して **「許可する」**
4. 表示される **Bot User OAuth Token**（`xoxb-...`）をコピー

### 4. プロジェクトのセットアップ

```bash
npm install
cp .env.example .env
```

`.env` を編集し、コピーしたトークンを設定:

```
SLACK_BOT_TOKEN=xoxb-ここにコピーしたトークンを貼る
```

### 5. Bot をチャンネルに招待

取得したいチャンネルで以下を投稿:

```
/invite @slack-extractor
```

Bot が参加しているチャンネルのみ取得対象になるので、対象チャンネルすべてで招待が必要です。

## 使い方

```bash
# 2024年1月〜2025年3月の全チャンネル
npm run extract -- --from 2024-01 --to 2025-03

# 2025年3月のみ、特定チャンネル
npm run extract -- --from 2025-03 --to 2025-03 dev

# 複数チャンネルを指定
npm run extract -- --from 2024-04 --to 2024-06 dev general
```

## 出力

`output/` ディレクトリにチャンネル名ごとのサブディレクトリが作成され、月単位の JSON ファイルが保存されます。

```
output/
  dev/
    2024-01.json
    2024-02.json
    ...
  general/
    2024-01.json
    ...
```

### JSON 構造

`messages` 配列にスレッドと単独メッセージが `ts`（タイムスタンプ）昇順で混在します。`type` フィールドで種別を区別できます。

```json
{
  "channel": { "id": "C12345", "name": "dev" },
  "period": "2024-01",
  "messages": [
    {
      "type": "message",
      "user": "田中太郎",
      "text": "単独メッセージ",
      "ts": "1704067200.000000",
      "date": "2024-01-01"
    },
    {
      "type": "thread",
      "thread_ts": "1704070800.000000",
      "ts": "1704070800.000000",
      "date": "2024-01-01",
      "parent_message": "スレッドの最初のメッセージ",
      "parent_user": "田中太郎",
      "reply_count": 3,
      "replies": [
        { "type": "message", "user": "田中太郎", "text": "...", "ts": "1704070800.000000", "date": "2024-01-01" },
        { "type": "message", "user": "佐藤花子", "text": "...", "ts": "1704074400.000000", "date": "2024-01-01" }
      ],
      "permalink": "https://app.slack.com/archives/C12345/p1704070800000000"
    }
  ],
  "metadata": {
    "extracted_at": "2025-03-03T10:00:00.000Z",
    "period": "2024-01",
    "total_threads": 15,
    "total_standalone_messages": 42,
    "total_messages": 120
  }
}
```

### 月を跨ぐスレッドについて

スレッドは**親メッセージの投稿月**に基づいて出力ファイルが決まります。親メッセージが1月に投稿されたスレッドに2月以降の返信がついた場合、それらの返信も含めて `2024-01.json` に格納されます。2月の出力ファイルにはそのスレッドは現れません。

## 技術スタック

- TypeScript / Node.js (ES2022)
- `@slack/web-api` - Slack API クライアント
- `tsx` - TypeScript の直接実行
