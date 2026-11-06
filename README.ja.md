# notecli（日本語ガイド）

note.com の記事を操作する非公式 CLI です。AI エージェントからの利用を想定しており、
標準出力が TTY でない場合は自動的に JSON を返します。

> **注意:** note.com とは無関係の非公式ツールです。内部 API を利用しているため、予告なく
> 動作しなくなる可能性があります。自己責任で利用し、note.com の利用規約を守ってください。

## 必要環境

- Node.js 20 以上
- note.com アカウント

## インストール

```bash
git clone <this-repository>
cd notecli
pnpm install
pnpm build
pnpm link --global
```

## 認証

ブラウザで note.com にログインし、DevTools の **Application → Cookies → https://note.com**
から次の 2 つをコピーします。

- `_note_session_v5`（HttpOnly のため `document.cookie` では取得できません）
- `XSRF-TOKEN`

### 環境変数（エージェント推奨）

```bash
export NOTE_COOKIE='_note_session_v5=...; XSRF-TOKEN=...'
notecli auth status --json
```

`NOTE_COOKIE` は次の形式を受け付けます。

- 生の Cookie ヘッダー
- JSON オブジェクト / Playwright 形式の JSON 配列
- Netscape 形式の `cookies.txt` の中身

### Cookie ファイル

```bash
export NOTE_COOKIE_FILE="$HOME/.note-cookies"
notecli auth status
```

### 保存ファイル

```bash
notecli auth login --cookie-file "$HOME/.note-cookies"
```

`~/.config/notecli/credentials.json` にパーミッション `0600` で保存されます。
保存場所は `NOTE_CONFIG_DIR` / `XDG_CONFIG_HOME` で変更できます。

優先順位は `NOTE_COOKIE` → `NOTE_COOKIE_FILE` → 保存ファイルです。

## コマンド例

```bash
# 下書き一覧
notecli list --status draft --limit 20

# 記事取得（Markdown）
notecli get n1234567890ab --json

# 標準入力から下書き作成
printf '# タイトル\n\n本文\n' | notecli create --title "タイトル" --json

# ファイルから作成して即公開
notecli create --title "リリースノート" --file article.md --publish --tags release,note

# タイトルだけ変更（本文は保持）
notecli update n1234567890ab --title "新しいタイトル"

# 本文を標準入力から差し替え
notecli update n1234567890ab --stdin < article.md

# 公開
notecli publish n1234567890ab --tags release,note

# プレビュー URL
notecli preview n1234567890ab --json

# 本文画像アップロード（JSON に Markdown スニペットが入ります）
notecli image n1234567890ab ./diagram.png

# アイキャッチ画像
notecli image n1234567890ab ./header.png --eyecatch

# 下書き削除（非対話では --yes 必須）
notecli delete n1234567890ab --yes
```

## Markdown 対応

見出し、段落、強調、リンク、リスト、コードブロック、画像に加えて、note.com 向けに次を変換します。

- `[TOC]` → 目次要素（最初の 1 つだけ）
- `> 引用` と `> — 出典 (https://example.com)` → 引用図とキャプション
- `->中央<-`、`->右`、`<-左` → 文字配置
- 単独行の対応 URL → 埋め込み（YouTube、X、note、GitHub、Gist、Google Slides、
  SpeakerDeck、note money、Zenn、Qiita、connpass）
- `^5243` / `$GOOG` → note money のリンク
- 画像 → note.com の `<figure>` 形式
- `$${a^2 + b^2 = c^2}$$` などの KaTeX 数式はそのまま渡されます

## エージェント向け仕様

- 非 TTY では JSON。`--json` で明示も可能
- 成功 JSON は stdout、エラー JSON は stderr
- 終了コード: `0` 成功、`2` 引数、`3` 認証、`4` 未検出、`5` レート制限、
  `6` API、`7` 入力不正
- 本文は `--stdin` / `--body -` で渡す
- `delete` は非 TTY で `--yes` 必須（公開済み記事は削除不可）
- Cookie の値は一切出力しません

詳細は [AGENTS.md](./AGENTS.md) を参照してください。

## 開発

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## ライセンス

MIT
