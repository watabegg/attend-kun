# attend-kun

超個人的な勤怠管理アプリ。フロントの「開始 / 中断 / 再開 / 終了」ボタンを押すと、
Microsoft Teams の指定チャットへ定型文を投稿する。将来的に D1 での打刻記録・月次集計・
請求書発行（②）と、Google Calendar からの週次稼働出力（③）を追加予定。

## アーキテクチャ

- **Cloudflare Worker**（`src/`）… UI 配信 + `POST /api/punch` を受けて Cloud Run を呼ぶ頭脳。
- **Cloud Run `teams-agent`**（`services/teams-agent/`）… Playwright で Teams にヘッドレス
  ログインし、Microsoft Graph で送信する重い処理。セッション（storageState）は GCS に永続化。

Entra アプリ登録ができない（ゲストアカウント）ため、Teams 送信は公式 OAuth ではなく
**ブラウザ自動化 + Gmail 経由の確認コード入力**で行う。ログイン後のセッションを再利用し、
MFA が走るのは初回とセッション失効時だけ。詳細は `services/teams-agent/README.md` を参照。

### 送信の流れ

```
[ブラウザUI] --POST /api/punch {type}--> [Worker] --POST /send {text}--> [Cloud Run teams-agent]
                                                                              |
                                          GCS(session) <--> Playwright --> Teams ログイン(必要時のみ)
                                                                              |
                                                          Graph API POST /chats/{id}/messages
```

## Worker の設定

```sh
# secrets
npx wrangler secret put APP_AUTH_TOKEN        # UI/APIのパスコード
npx wrangler secret put AGENT_SHARED_SECRET   # teams-agent と共有する秘密鍵
```

`wrangler.jsonc` の `vars`:

- `TEAMS_AGENT_URL`: Cloud Run のURL（初回デプロイ後に設定）。
- `TARGET_CHAT_NAME`: UIに表示する送信先チャット名。

リポジトリ内の値は公開用プレースホルダーである。実際のURL、ログインメール、tenant ID、
chat ID、OAuth情報、セッション状態はコミットせず、Cloudflare Secrets、Google Secret
Manager、またはデプロイ時の環境変数から渡す。

## エンドポイント

- `GET /` … 4ボタンのUI。
- `GET /health` … 死活監視。
- `POST /api/punch` … `{ "type": "start|end|break|resume" }`。`Authorization: Bearer <APP_AUTH_TOKEN>` 必須。

## 開発

```sh
npm install
npm run check
npm test
npx wrangler dev
```

Cloud Run 側は `services/teams-agent/README.md` を参照。
