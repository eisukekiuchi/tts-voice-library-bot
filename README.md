# TTS Voice Library Bot

Discordの読み上げBOTを、一般メンバーがコマンドを覚えなくても使えるようにしたボタン式BOTです。

## 一般メンバーの操作

- VC接続 / 切断
- 読み上げON / OFF
- スキップ
- ボイス一覧
- お気に入り
- ボイス検索
- このチャンネルを読む
- 速度変更
- 音量変更
- 混雑状況
- 各ボイスのVC試聴 / 音声ファイル試聴 / 選択

検索と辞書登録は、Discordのボタンを押したあとに開く入力ウィンドウを使います。スラッシュコマンド入力は不要です。

## 大量入力・長文対応

- TTS生成を並列化
- 長文を自然な位置で自動分割
- 後続メッセージも先行生成
- VC再生順はDiscord投稿順を維持
- 同文・同声・同設定は音声キャッシュ再利用
- 同一生成の重複実行を抑止
- バックログ上限あり

## Railway

状態保存と音声キャッシュは DATA_DIR / CACHE_DIR に保存します。
Railway Volumeを /data にマウントする構成を推奨します。

必須:
- DISCORD_TOKEN

Discord Developer Portalでは MESSAGE CONTENT INTENT を有効にしてください。

音声エンジンは VOICEVOX互換HTTP APIを利用します。
VOICEVOX / AivisSpeech などをENGINE_ENDPOINTSに登録できます。
