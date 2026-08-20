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

管理画面 `/admin/apps` > 連携アプリの追加 から登録する:

- **アプリ名**: `ChainDrop`
- **クライアントID**: `chaindrop`
- **リダイレクトURI**: `https://<Railwayのドメイン>/api/auth/techmana/callback`
- **許可オリジン**: **空のまま**(理由は下記)
- **スコープ**: `save` にチェック(hidden が `profile save` になる)
- **公開アプリ**: チェックしない(chaindrop はシークレットを持つ機密クライアント)

#### 許可オリジンを空にする理由

chaindrop のブラウザはテクマナのドメインを一切知らない。同意画面へは
トップレベル遷移で移動するだけで、`fetch` の宛先は全て自前のサーバ
(Railway)。つまり CORS ヘッダは最初から不要。

さらに `ApiController::applyCors()` の照会には **client_id の条件が無い**:

```sql
SELECT 1 FROM el_oauth_clients
 WHERE status = 'active' AND FIND_IN_SET(?, ...allowed_origins...) > 0
```

ここに書いたオリジンは「そのアプリのために開く」のではなく、テクマナの
`/api/v1/*` 全体に対して、現在および将来の全クライアント分まとめて開く。
必要のないオリジンは書かない。ブラウザ直叩きが後から必要になったら
編集画面で足せる(`status` を変えない限りトークンは失効しない)。

`client_secret` は登録直後に一度だけ表示され、以後は再表示できない
(DB には bcrypt ハッシュしか残らない)。控え損ねたら再発行するしかない。

ブラウザを開けない場合は同じ処理を行う CLI がある:

```bash
php bin/register_oauth_client.php chaindrop 'ChainDrop' \
  'https://<Railwayのドメイン>/api/auth/techmana/callback' \
  '' \
  'profile save'
```

標準出力に平文シークレットだけを出すので、そのまま次の手順へ渡せる:

```bash
ssh <server> 'cd ~/ses-elearning && php8.3 bin/register_oauth_client.php ...' \
  | railway variables --set-from-stdin TECHMANA_CLIENT_SECRET
```

このスクリプトは登録後に `password_verify` と実際のトークンエンドポイント
呼び出しでシークレットが通ることを確認してから終了する。

#### 値が1文字でも違うと落ちる箇所

| 項目 | 規則 |
| --- | --- |
| `redirect_uris` | **完全一致**。前方一致もURL正規化もしない。複数書く場合は改行(LF)区切り |
| `allowed_origins` | 空で良い。書く場合はスキーム必須・パス不可。**末尾スラッシュがあると CORS 照合に失敗する** |
| `scopes` | 空白区切り。`profile` と `save` 以外は無視される。管理UIでは自由入力ではなく `save` チェックボックスが hidden を書き換える方式なので、登録後に一覧で `profile save` に なっているか目視確認する(`profile` だけだと連携は成功するのにセーブAPIだけ 403 になる) |
| `status` | `active` 以外は全ての照会経路で弾かれる |

`redirect_uri` はトークン取得時にも再検証される。このときは登録一覧では
なく認可コードに凍結された値と比較されるため、`/oauth/authorize` と
`/oauth/token` で同一の文字列を送る必要がある(chaindrop は同じ
`TECHMANA_REDIRECT_URI` を使うので自動的に満たされる)。

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
- **`/data` に永続ボリュームが実際にマウントされていること**

最後の項目は変数の設定だけでは足りない。`DATABASE_PATH=/data/chaindrop.db`
が設定済みでもボリュームが無ければ `/data` はコンテナ内の一時領域になり
(`openDatabase` が親ディレクトリを自動作成するため起動は成功してしまう)、
**再デプロイのたびに全アカウントが消える**。確認と作成:

```bash
railway volume list --json      # mountPath が /data のものがあるか
railway volume add --mount-path /data
```

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
