/**
 * 素材B: 2人のMTG（約10分）。
 * マイク系統（自分 = Kyoko）と PC音声系統（相手 = Reed）の2系統。
 * bleedToMic: true の行は、スピーカーからマイクへ回り込んだ二重取りを模擬する。
 * 結論が出る話題（decided）と出ない話題（needs_check）を混ぜている。
 */
import type { Material } from './types';

export const materialB: Material = {
  name: 'B',
  voices: { self: 'Kyoko', other: 'Reed (Japanese (Japan))' },
  rate: 148,
  twoSpeakers: true,
  startedAt: '2026-10-02T14:05:00+09:00',
  initialNav: { type: 'nav', at: 0, url: 'http://localhost:3000/', title: 'ホーム | Acme', viewport: 1280 },
  lines: [
    { speaker: 'self', gap: 500, text: 'では録画を始めます。画面共有できていますか', item: null },
    { speaker: 'other', gap: 900, text: 'はい、見えています', item: null, bleedToMic: true },

    // 話題1: ヒーローのコピー（結論あり）
    {
      speaker: 'other',
      gap: 2600,
      text: 'トップのこのキャッチコピーなんですけど、何のサービスか分からないですね',
      item: 'b1',
      bleedToMic: true,
      cues: [{ type: 'pen', at: 1000, id: 'p1', durationMs: 1500, bbox: [300, 170, 560, 100], selector: 'h1.hero-title', text: 'すべてのチームに、ひとつの場所を' }],
    },
    { speaker: 'self', gap: 800, text: '確かに抽象的すぎますね。サブコピーに何ができるか具体的に書きましょうか', item: 'b1' },
    { speaker: 'other', gap: 700, text: 'そうしてください。タスク管理と書いてあれば分かります', item: 'b1' },
    { speaker: 'self', gap: 600, text: 'ではサブコピーをチームのタスク管理を一か所にという文に変えます', item: 'b1' },

    // 話題2: CTAボタンの色（結論あり）
    {
      speaker: 'other',
      gap: 2700,
      text: 'あとこの無料で始めるのボタン、色が薄くて押せるように見えないです',
      item: 'b2',
      bleedToMic: true,
      cues: [{ type: 'pen', at: 1300, id: 'p2', durationMs: 1100, bbox: [560, 420, 200, 56], selector: 'button.hero-cta', text: '無料で始める' }],
    },
    { speaker: 'self', gap: 700, text: 'じゃあもっと濃くしますね。ブランドカラーの青でいいですか', item: 'b2' },
    { speaker: 'other', gap: 800, text: 'はい、それでお願いします', item: 'b2' },

    // 話題3: ログインの位置（結論が出ない）
    {
      speaker: 'other',
      gap: 2600,
      text: 'ログインのリンクが右上にあるんですけど、これ分かりにくくないですか',
      item: 'b3',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 900, text: 'うーん、一般的には右上ですけどね。ボタンにした方がいいですか', item: 'b3' },
    { speaker: 'other', gap: 800, text: 'どうでしょうね。既存のお客さんが迷ってるという話は聞いてないです', item: 'b3' },
    { speaker: 'self', gap: 700, text: '一旦このままにして、問い合わせが出たら考えましょうか', item: 'b3' },
    { speaker: 'other', gap: 900, text: 'そうですね、保留でお願いします', item: 'b3' },

    { speaker: 'self', gap: 2500, text: 'えーっと、料金ページ行きます', item: null },

    // 話題4: 料金表のトグル（結論あり）
    {
      speaker: 'other',
      gap: 1900,
      text: '月額と年額の切り替えが、今どっちが選ばれてるのか分かりません',
      item: 'b4',
      bleedToMic: true,
      cues: [
        { type: 'click', at: -1400, x: 980, y: 28, selector: 'a.nav-pricing', text: '料金' },
        { type: 'nav', at: -700, url: 'http://localhost:3000/pricing', title: '料金 | Acme', viewport: 1280 },
        { type: 'pen', at: 1200, id: 'p3', durationMs: 1300, bbox: [520, 170, 240, 44], selector: 'div.billing-toggle' },
      ],
    },
    { speaker: 'self', gap: 700, text: '選ばれている方を濃い色にして、白抜きの文字にします', item: 'b4' },
    { speaker: 'other', gap: 800, text: 'お願いします。あと年額だと何パーセント安いのかも書いてほしいです', item: 'b4' },
    { speaker: 'self', gap: 700, text: '二か月分お得と入れておきますね', item: 'b4' },

    // 話題5: プランの価格（結論が出ない・要確認）
    {
      speaker: 'other',
      gap: 2700,
      text: 'スタンダードの価格、この金額で確定でしたっけ',
      item: 'b5',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 900, text: 'いや、まだ仮です。営業と詰めている途中だと思います', item: 'b5' },
    { speaker: 'other', gap: 800, text: 'じゃあ金額は触らないでおきましょう。決まったら連絡します', item: 'b5' },

    // 話題6: 表記ゆれ（結論あり・テキスト入力）
    {
      speaker: 'self',
      gap: 2600,
      text: 'ここの単位の書き方がページによってバラバラなんですよ',
      item: 'b6',
      cues: [{ type: 'text', at: 1100, id: 'x1', x: 620, y: 300, body: '単位は「月額」に統一（「月々」「ひと月あたり」を廃止）', selector: 'span.plan-price-unit', elText: 'ひと月あたり' }],
    },
    { speaker: 'other', gap: 800, text: '月額で統一してください。社内の表記ルールもそうなっています', item: 'b6', bleedToMic: true },

    // 話題7: 税込表記（結論あり）
    {
      speaker: 'other',
      gap: 2600,
      text: 'これ税抜ですよね。書いてないと問題になります',
      item: 'b7',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 700, text: '価格の横に小さく税抜と入れます', item: 'b7' },
    { speaker: 'other', gap: 700, text: 'はい、法務からも言われているので必須でお願いします', item: 'b7' },

    { speaker: 'self', gap: 2500, text: 'ちょっとスクロールしますね', item: null, cues: [{ type: 'scroll', at: 400, y: 1200 }] },

    // 話題8: FAQ（結論あり）
    {
      speaker: 'other',
      gap: 2400,
      text: 'よくある質問の中身が古いです。解約の条件が去年のままになっています',
      item: 'b8',
      bleedToMic: true,
      cues: [{ type: 'click', at: 500, x: 640, y: 720, selector: 'button.faq-item-3', text: '解約はいつでもできますか' }],
    },
    { speaker: 'self', gap: 800, text: '最新の文言をもらえますか。差し替えます', item: 'b8' },
    { speaker: 'other', gap: 800, text: '今日の夕方に送ります', item: 'b8' },

    // 話題9: 申し込みフォームの項目数（結論が出ない）
    {
      speaker: 'other',
      gap: 2500,
      text: '申し込みの入力項目、ちょっと多いですね。これ全部必須ですか',
      item: 'b9',
      bleedToMic: true,
      cues: [
        { type: 'click', at: -1500, x: 640, y: 520, selector: 'button.plan-cta', text: '申し込む' },
        { type: 'nav', at: -800, url: 'http://localhost:3000/signup', title: '申し込み | Acme', viewport: 1280 },
      ],
    },
    { speaker: 'self', gap: 900, text: '会社名と電話番号は任意にできるかもしれません。営業側が使っているか分からないです', item: 'b9' },
    { speaker: 'other', gap: 800, text: '確認してから決めましょう', item: 'b9' },

    // 話題10: パスワードの条件（結論あり）
    {
      speaker: 'self',
      gap: 2600,
      text: 'パスワードの条件が、入力した後にしか出ないんですよね',
      item: 'b10',
      cues: [{ type: 'pen', at: 1200, id: 'p4', durationMs: 1000, bbox: [460, 400, 360, 48], selector: 'input#password' }],
    },
    { speaker: 'other', gap: 800, text: 'それは最初から出しておいてください。入力し直すのが面倒です', item: 'b10', bleedToMic: true },
    { speaker: 'self', gap: 700, text: '欄の下に常に条件を出すようにします', item: 'b10' },

    // 話題11: エラー表示（結論あり）
    {
      speaker: 'other',
      gap: 2600,
      text: 'エラーが出たときに、どの欄が間違っているのか分かりにくいです',
      item: 'b11',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 800, text: '欄の枠を赤くして、欄の下にメッセージを出します', item: 'b11' },

    // 話題12: 二重送信（結論あり）
    {
      speaker: 'self',
      gap: 2500,
      text: 'あと送信ボタンが連打できてしまうので、押したら無効にします',
      item: 'b12',
    },
    { speaker: 'other', gap: 800, text: 'お願いします。前に二重登録が起きたことがあります', item: 'b12', bleedToMic: true },

    // 話題13: ダッシュボードのグラフ（結論が出ない）
    {
      speaker: 'other',
      gap: 2500,
      text: 'ダッシュボードのこのグラフ、何を表しているのか分からないです',
      item: 'b13',
      bleedToMic: true,
      cues: [
        { type: 'nav', at: -900, url: 'http://localhost:3000/dashboard', title: 'ダッシュボード | Acme', viewport: 1280 },
        { type: 'pen', at: 1100, id: 'p5', durationMs: 1500, bbox: [200, 260, 480, 280], selector: 'svg.usage-chart' },
      ],
    },
    { speaker: 'self', gap: 900, text: '日ごとの利用件数です。タイトルを付けた方がいいですか', item: 'b13' },
    { speaker: 'other', gap: 900, text: 'タイトルだけだと足りない気もします。何を見てほしいのか整理してから決めたいです', item: 'b13' },
    { speaker: 'self', gap: 800, text: '分かりました、一度案を出します', item: 'b13' },

    // 雑談（指摘でない）
    { speaker: 'other', gap: 2500, text: 'そういえば来週の定例、火曜に動かせますか', item: null, bleedToMic: true },
    { speaker: 'self', gap: 900, text: '大丈夫です。あとでカレンダー送ります', item: null },

    // 話題14: スマホ幅の表（結論あり）
    {
      speaker: 'self',
      gap: 2600,
      text: 'スマホ幅にすると、この表が右にはみ出します',
      item: 'b14',
      cues: [{ type: 'nav', at: -800, url: 'http://localhost:3000/dashboard', title: 'ダッシュボード | Acme', viewport: 390 }],
    },
    { speaker: 'other', gap: 800, text: '横にスクロールできれば十分です。列を減らすのはやめてください', item: 'b14', bleedToMic: true },
    { speaker: 'self', gap: 700, text: '表だけ横スクロールにします', item: 'b14' },

    // 話題15: サイドバーのアイコン（結論あり）
    {
      speaker: 'other',
      gap: 3200,
      text: '左のサイドバー、アイコンだけだと何の画面か分からないです',
      item: 'b15',
      bleedToMic: true,
      cues: [{ type: 'pen', at: 1000, id: 'p6', durationMs: 1200, bbox: [10, 120, 60, 240], selector: 'nav.sidebar' }],
    },
    { speaker: 'self', gap: 900, text: 'アイコンの下に文字を入れますか。それともマウスを乗せたときに出しますか', item: 'b15' },
    { speaker: 'other', gap: 900, text: '常に文字を出してください。覚えないと使えないのは良くないです', item: 'b15' },
    { speaker: 'self', gap: 700, text: '分かりました、アイコンの横にラベルを常時表示にします', item: 'b15' },

    // 話題16: 通知の未読件数（結論あり）
    {
      speaker: 'other',
      gap: 3300,
      text: 'あとこのベルのアイコン、未読があるかどうかが分からないです',
      item: 'b16',
      bleedToMic: true,
      cues: [{ type: 'click', at: 700, x: 1180, y: 28, selector: 'button.notif-bell', text: '通知' }],
    },
    { speaker: 'self', gap: 800, text: '未読の件数を赤い丸で出すようにします', item: 'b16' },
    { speaker: 'other', gap: 800, text: 'はい、数字まで出してもらえると助かります', item: 'b16' },

    // 話題17: 検索0件の表示（結論が出ない）
    {
      speaker: 'self',
      gap: 3300,
      text: '検索して結果が無いときの画面、今は何も出ないんですよ',
      item: 'b17',
      cues: [{ type: 'click', at: -1000, x: 700, y: 120, selector: 'input.search-box' }],
    },
    { speaker: 'other', gap: 900, text: '何か出した方がいいですね。何て書くのがいいんでしょう', item: 'b17', bleedToMic: true },
    { speaker: 'self', gap: 900, text: '見つかりませんでした、だけだと冷たいので、条件を変える案も出しますか', item: 'b17' },
    { speaker: 'other', gap: 900, text: '文言は持ち帰って考えます。次回決めましょう', item: 'b17', bleedToMic: true },

    // 話題18: 日付の表記（結論あり）
    {
      speaker: 'other',
      gap: 3200,
      text: '日付の書き方が画面によって違います。ここは十月二日で、一覧は二〇二六年十月二日になっています',
      item: 'b18',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 800, text: 'スラッシュ区切りの年月日に統一しますか', item: 'b18' },
    { speaker: 'other', gap: 800, text: 'それでお願いします。全部の画面で揃えてください', item: 'b18' },

    // 話題19: 一覧の並び順（結論あり）
    {
      speaker: 'other',
      gap: 3300,
      text: '一覧を開くと古いものが上に来ます。これ逆の方がいいです',
      item: 'b19',
      bleedToMic: true,
      cues: [
        { type: 'nav', at: -900, url: 'http://localhost:3000/projects', title: 'プロジェクト一覧 | Acme', viewport: 1280 },
      ],
    },
    { speaker: 'self', gap: 800, text: '更新日の新しい順を既定にします', item: 'b19' },

    // 話題20: CSV書き出しが遅い（結論が出ない）
    {
      speaker: 'other',
      gap: 3300,
      text: 'CSVの書き出しが、件数が多いと十秒以上かかるんですよね',
      item: 'b20',
      bleedToMic: true,
      cues: [{ type: 'click', at: 800, x: 1100, y: 160, selector: 'button.export-csv', text: 'CSV書き出し' }],
    },
    { speaker: 'self', gap: 1000, text: 'どこが遅いのかまだ見ていないので、調べないと直し方が決まりません', item: 'b20' },
    { speaker: 'other', gap: 900, text: 'じゃあまず原因を調べてもらって、それから相談しましょう', item: 'b20', bleedToMic: true },

    // 話題21: 保存ボタンの位置（結論あり）
    {
      speaker: 'other',
      gap: 3200,
      text: '設定画面の保存ボタンが一番下にあって、スクロールしないと見えません',
      item: 'b21',
      bleedToMic: true,
      cues: [
        { type: 'nav', at: -900, url: 'http://localhost:3000/settings', title: '設定 | Acme', viewport: 1280 },
        { type: 'pen', at: 1300, id: 'p7', durationMs: 1100, bbox: [540, 900, 180, 48], selector: 'button.settings-save', text: '保存' },
      ],
    },
    { speaker: 'self', gap: 800, text: '画面の下に固定して、常に見えるようにします', item: 'b21' },
    { speaker: 'other', gap: 800, text: 'それでお願いします', item: 'b21' },

    // 話題22: ダークモード（結論が出ない）
    {
      speaker: 'other',
      gap: 3300,
      text: 'あと要望なんですけど、ダークモードは入る予定ありますか',
      item: 'b22',
      bleedToMic: true,
    },
    { speaker: 'self', gap: 900, text: '今のところ入っていません。色を全部見直すことになるので、それなりに時間がかかります', item: 'b22' },
    { speaker: 'other', gap: 900, text: '優先度は高くないので、他が終わってからで大丈夫です', item: 'b22', bleedToMic: true },
    { speaker: 'self', gap: 800, text: 'では今回はやらない方向で、改めて相談させてください', item: 'b22' },

    { speaker: 'self', gap: 3000, text: 'では以上で。ありがとうございました', item: null },
    { speaker: 'other', gap: 800, text: 'ありがとうございました', item: null, bleedToMic: true },
  ],
  expected: [
    { id: 'b1', gist: 'ヒーローのサブコピーに「チームのタスク管理を一か所に」と具体的に書く', status: 'decided' },
    { id: 'b2', gist: '「無料で始める」ボタンをブランドカラーの濃い青にする', status: 'decided' },
    { id: 'b3', gist: 'ログインリンクの位置・形は保留（問い合わせが出たら再検討）', status: 'needs_check' },
    { id: 'b4', gist: '月額／年額トグルの選択中を濃い色＋白抜きにし、年額は「二か月分お得」を併記', status: 'decided' },
    { id: 'b5', gist: 'スタンダードの価格は仮のため触らない（営業と確定待ち）', status: 'needs_check' },
    { id: 'b6', gist: '価格の単位表記を「月額」に統一する', status: 'decided' },
    { id: 'b7', gist: '価格の横に「税抜」を入れる（法務要件）', status: 'decided' },
    { id: 'b8', gist: 'FAQの解約条件を最新の文言に差し替える（相手が夕方に送付）', status: 'decided' },
    { id: 'b9', gist: '申し込みフォームの会社名・電話番号を任意にできるか確認が必要', status: 'needs_check' },
    { id: 'b10', gist: 'パスワードの条件を欄の下に常に表示する', status: 'decided' },
    { id: 'b11', gist: 'エラー時に欄の枠を赤くし、欄の下にメッセージを出す', status: 'decided' },
    { id: 'b12', gist: '送信ボタンを押したら無効にして二重送信を防ぐ', status: 'decided' },
    { id: 'b13', gist: 'ダッシュボードのグラフの見せ方は案を出してから決める', status: 'needs_check' },
    { id: 'b14', gist: 'スマホ幅で表を横スクロールにする（列は減らさない）', status: 'decided' },
    { id: 'b15', gist: 'サイドバーのアイコンの横にラベルを常時表示する', status: 'decided' },
    { id: 'b16', gist: '通知ベルに未読件数を赤い丸＋数字で出す', status: 'decided' },
    { id: 'b17', gist: '検索0件時の表示は必要だが文言は次回決める', status: 'needs_check' },
    { id: 'b18', gist: '日付表記をスラッシュ区切りの年月日に全画面で統一する', status: 'decided' },
    { id: 'b19', gist: '一覧の既定の並び順を更新日の新しい順にする', status: 'decided' },
    { id: 'b20', gist: 'CSV書き出しが遅い。まず原因を調べてから対応を相談する', status: 'needs_check' },
    { id: 'b21', gist: '設定画面の保存ボタンを画面下に固定する', status: 'decided' },
    { id: 'b22', gist: 'ダークモードは今回やらない方向。改めて相談する', status: 'needs_check' },
  ],
};
