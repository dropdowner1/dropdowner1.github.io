# テクマナ連携 (Techmana SSO + クラウドセーブ)

ChainDrop のアカウントを社内システム「テクマナ」と紐付け、セーブデータを
テクマナ側のアカウントに保存する仕組み。別の端末でも続きから遊べる。

## 全体像

```
ブラウザ                ChainDrop サーバ (Railway)          テクマナ
   |  「テクマナでログイン」        |                            |
   |----- GET /api/auth/techmana/start -->|                     |
   |<---- 302 + 一時 Cookie --------------|                     |
   |------------------- 同意画面へ ------------------------------>|
   |<------------------ 302 code ---------------------------------|
   |----- GET .../callback?code -------->|                       |
   |                                     |--- POST /oauth/token ->|
   |                                     |<-- access/refresh -----|
   |                                     |--- GET /api/v1/me ---->|
   |<---- 302 + セッション Cookie --------|                       |
```

ポイント: **テクマナのトークンはブラウザに一切渡さない**。ChainDrop
サーバが機密クライアントとしてトークンを保持し、セーブ操作は
`ブラウザ → ChainDrop サーバ → テクマナ` の中継で行う。

この形にした理由:

- クライアントは GitHub Pages 配信で router を持たないため、
  `/auth/callback` のようなパスは 404 になる。redirect_uri を Railway 側
  にすればその問題自体が起きない
- XSS でテクマナのトークンが盗まれる経路が存在しない
- サーバ間通信なのでテクマナ側の CORS 設定に依存しない

## 併存方針

テクマナ連携は「ログイン手段の追加」であり、既存の ID+パスワードの
アカウントは移行しない。

| 状況 | 結果 |
| --- | --- |
| そのテクマナ ID に紐付いた ChainDrop アカウントが既にある | それでログイン |
| ChainDrop にログイン中に「連携する」を押した | 今のアカウントに紐付け |
| どちらでもない | `tm<テクマナuser_id>` で新規アカウント作成 |

新規作成されたアカウントの `password_hash` にはランダム値の bcrypt
ハッシュが入る。つまり構造的にパスワードログインができない。

## サーバ側

| ファイル | 役割 |
| --- | --- |
| `packages/server/src/auth/TechmanaService.ts` | 認可URL組立 / トークン交換 / 自動リフレッシュ / セーブ中継 |
| `packages/server/src/routes/techmana.ts` | `/api/auth/techmana/*` と `/api/sync/*` |
| `packages/server/src/db/schema.ts` | `oauth_links` テーブル |

`oauth_links` は `users` への列追加ではなく別テーブルにしてある。
`schema.ts` の DDL は全て `CREATE TABLE IF NOT EXISTS` なので、既存の本番
DB に対して列を足しても**何も起きない**。新規テーブルなら次回起動時に
作られるため、マイグレーションランナー無しで反映できる。

### エンドポイント

| メソッド | パス | 認証 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/auth/techmana/start` | 任意 | 同意画面へリダイレクト |
| GET | `/api/auth/techmana/callback` | — | テクマナからの戻り先 |
| GET | `/api/auth/techmana/status` | 必須 | 連携状態 |
| POST | `/api/auth/techmana/unlink` | 必須 | 連携解除 |
| GET | `/api/sync/save` | 必須 | クラウドセーブ読み出し |
| PUT | `/api/sync/save` | 必須 | クラウドセーブ書き込み |

## クライアント側

| ファイル | 役割 |
| --- | --- |
| `packages/client/src/api/sync.ts` | 上記エンドポイントの薄いラッパ |
| `packages/client/src/state/cloudSave.ts` | セーブ本体の組立・マージ・同期 |
| `packages/client/src/state/persistBus.ts` | localStorage 書き込みの通知 |

同期対象は **他に保存先が無いものだけ**: 設定・ソロ難易度・記録の
ローカルミラー。オンライン対戦の戦績は既に `/api/records` で ChainDrop
自身の DB に入るため、ここでは扱わない。

### 競合解決

`save_seq` が単調増加でないとテクマナ側が 409 を返す。負けた側は
勝った内容を取り込んでから 1 回だけ再送する。マージは
「後勝ち」ではなく:

- ベストスコア・最大連鎖・消去数 → それぞれ **max**
- オンライン戦績 → **和集合**(重複除去、新しい順に 50 件)
- 設定・難易度 → `updatedAt` が新しい方

2 台がオフラインで遊べば両方に本物の記録が溜まる。後から同期した側を
捨てると実際に遊んだ試合が消えるため、max と和集合を取る。

## デプロイ手順

### 1. テクマナ側にクライアント登録

管理画面 > 連携アプリ で新規登録:

- **redirect_uri**: `https://<Railwayのドメイン>/api/auth/techmana/callback`
- **allowed_origins**: `https://dropdowner1.github.io`
- **scope**: `profile save`

発行された `client_id` / `client_secret` を控える。

### 2. Railway に環境変数を設定

```
TECHMANA_BASE_URL=https://techmana.adamant-group.jp
TECHMANA_CLIENT_ID=<発行された値>
TECHMANA_CLIENT_SECRET=<発行された値>
TECHMANA_REDIRECT_URI=https://<Railwayのドメイン>/api/auth/techmana/callback
CLIENT_BASE_URL=https://dropdowner1.github.io/
```

同時に以下も確認する(未設定だと連携以前に壊れる):

- `JWT_SECRET` — 未設定だと起動ごとに全セッションが無効化される
- `DATABASE_PATH` — 永続ボリューム上のパス。`:memory:` だと再デプロイで
  アカウントごと消える
- `ALLOWED_ORIGINS` — `https://dropdowner1.github.io` を含むこと。
  `*` だとブラウザが Cookie を送らない

`TECHMANA_REDIRECT_URI` はテクマナ側の登録値と 1 文字でも違うと
テクマナが認可を拒否する。

### 3. 動作確認

1. `https://dropdowner1.github.io/` を開く
2. アカウント > 「テクマナでログイン」
3. テクマナの同意画面 → 許可
4. ゲームに戻り「テクマナと連携しました」のバナーが出る
5. 設定を変えて別のブラウザから同じテクマナアカウントでログインし、
   設定が引き継がれることを確認する

失敗時は `?techmana=error&reason=...` で戻る。`reason` の意味:

| reason | 意味 |
| --- | --- |
| `denied` | 同意画面で拒否された |
| `expired` / `state` | 一時 Cookie の期限切れ、または state 不一致 |
| `disabled` | サーバに Techmana の設定が入っていない |
| `error` | トークン交換またはプロフィール取得に失敗 |
