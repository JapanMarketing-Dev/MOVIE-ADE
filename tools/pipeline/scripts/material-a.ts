/**
 * 素材A: 1人でUIレビュー（約5分、指摘20件）。
 * つなぎ言葉・独り言を混ぜている。item: null が「指摘でない発話」の正解。
 */
import type { Material } from './types';

export const materialA: Material = {
  name: 'A',
  voices: { self: 'Kyoko' },
  rate: 148,
  twoSpeakers: false,
  startedAt: '2026-10-02T10:40:12+09:00',
  initialNav: { type: 'nav', at: 0, url: 'http://localhost:3000/', title: 'ホーム | Acme', viewport: 1280 },
  lines: [
    { speaker: 'self', gap: 600, text: 'えーっと、じゃあ画面見ていきますね', item: null },

    {
      speaker: 'self',
      gap: 4000,
      text: 'まずトップのこの大きい見出しですけど、文字が小さいです',
      item: 'a1',
      cues: [{ type: 'pen', at: 900, id: 'p1', durationMs: 1400, bbox: [320, 180, 520, 90], selector: 'h1.hero-title', text: 'すべてのチームに、ひとつの場所を' }],
    },
    { speaker: 'self', gap: 700, text: 'ひとまわり大きくして、太字にしてください', item: 'a1' },

    { speaker: 'self', gap: 3900, text: 'うーん、次', item: null },

    {
      speaker: 'self',
      gap: 3800,
      text: 'この無料で始めるボタン、色が薄くて押せるように見えないんですよね',
      item: 'a2',
      cues: [{ type: 'pen', at: 1200, id: 'p2', durationMs: 1100, bbox: [560, 420, 200, 56], selector: 'button.hero-cta', text: '無料で始める' }],
    },
    { speaker: 'self', gap: 900, text: 'もっと濃い青にして、押せることが分かるようにしたいです', item: 'a2' },

    {
      speaker: 'self',
      gap: 4000,
      text: 'あとそのボタンの下の注意書きが薄いグレーで読めないので、もう少し濃くしてください',
      item: 'a3',
    },

    {
      speaker: 'self',
      gap: 4100,
      text: 'ヘッダーのロゴが少し左に寄りすぎています。もう少し内側に入れてほしい',
      item: 'a4',
      cues: [{ type: 'pen', at: 800, id: 'p3', durationMs: 900, bbox: [20, 16, 140, 40], selector: 'a.site-logo', text: 'Acme' }],
    },

    { speaker: 'self', gap: 3900, text: 'ちょっとスクロールします', item: null, cues: [{ type: 'scroll', at: 300, y: 900 }] },

    {
      speaker: 'self',
      gap: 3700,
      text: '機能の3つのカードが縦に間延びしています。カードの余白を詰めて、高さを揃えてください',
      item: 'a5',
    },

    {
      speaker: 'self',
      gap: 4000,
      text: 'カードの中のアイコンが全部同じ色なので、見分けが付きません。機能ごとに色を変えたいです',
      item: 'a6',
    },

    {
      speaker: 'self',
      gap: 3900,
      text: 'お客様の声のところ、顔写真が四角いので丸く切り抜いてください',
      item: 'a7',
    },

    { speaker: 'self', gap: 3800, text: 'えー、料金のページに行きます', item: null },

    {
      speaker: 'self',
      gap: 1800,
      text: '料金表の月額と年額の切り替えが分かりにくいです。トグルを大きくして、今どちらが選ばれているか色で分かるようにしてください',
      item: 'a8',
      cues: [
        { type: 'click', at: -1200, x: 980, y: 28, selector: 'a.nav-pricing', text: '料金' },
        { type: 'nav', at: -600, url: 'http://localhost:3000/pricing', title: '料金 | Acme', viewport: 1280 },
        { type: 'pen', at: 1500, id: 'p4', durationMs: 1200, bbox: [520, 170, 240, 44], selector: 'div.billing-toggle' },
      ],
    },

    {
      speaker: 'self',
      gap: 4000,
      text: 'プランの名前がベーシックとスタンダードで紛らわしいです。スタンダードの方をプロに変えたいです',
      item: 'a9',
    },

    {
      speaker: 'self',
      gap: 3900,
      text: '真ん中のプランが一番おすすめなので、おすすめのバッジを付けて枠線を太くしてください',
      item: 'a10',
      cues: [{ type: 'pen', at: 1100, id: 'p5', durationMs: 1300, bbox: [500, 240, 280, 360], selector: 'div.plan-card.standard' }],
    },

    {
      speaker: 'self',
      gap: 4000,
      text: '申し込むボタンが3つ並んでいて全部同じ見た目です。真ん中だけ塗りにして、両脇は枠線だけにしてください',
      item: 'a11',
    },

    {
      speaker: 'self',
      gap: 3800,
      text: 'この表記ゆれが気になります',
      item: 'a12',
      cues: [
        { type: 'text', at: 900, id: 'x1', x: 620, y: 300, body: '「月額」表記に統一（「月々」「ひと月」をやめる）', selector: 'span.plan-price-unit', elText: 'ひと月あたり' },
      ],
    },

    { speaker: 'self', gap: 3900, text: 'あ、そうだ', item: null },

    {
      speaker: 'self',
      gap: 3700,
      text: '税込みか税抜きかが書いてないので、価格の横に税抜と入れてください',
      item: 'a13',
    },

    {
      speaker: 'self',
      gap: 4000,
      text: 'よくある質問のアコーディオンが、クリックしても開くまで一瞬止まって見えます。アニメーションを速くしてください',
      item: 'a14',
      cues: [{ type: 'click', at: 600, x: 640, y: 720, selector: 'button.faq-item-3', text: '解約はいつでもできますか' }],
    },

    { speaker: 'self', gap: 3900, text: 'じゃあ申し込みフォーム見ます', item: null },

    {
      speaker: 'self',
      gap: 1900,
      text: '入力欄のラベルが入力欄の中にしか無いので、入力すると何の欄か分からなくなります。ラベルを欄の上に出してください',
      item: 'a15',
      cues: [
        { type: 'click', at: -1300, x: 640, y: 520, selector: 'button.plan-cta', text: '申し込む' },
        { type: 'nav', at: -700, url: 'http://localhost:3000/signup', title: '申し込み | Acme', viewport: 1280 },
      ],
    },

    {
      speaker: 'self',
      gap: 3900,
      text: 'パスワードの条件が入力した後にしか出ません。最初から条件を表示しておいてください',
      item: 'a16',
      cues: [{ type: 'pen', at: 1300, id: 'p6', durationMs: 1000, bbox: [460, 400, 360, 48], selector: 'input#password' }],
    },

    {
      speaker: 'self',
      gap: 4000,
      text: 'エラーメッセージが赤い文字だけで小さいです。欄の枠も赤くして、アイコンも付けてください',
      item: 'a17',
    },

    {
      speaker: 'self',
      gap: 3800,
      text: '送信ボタンが押した後も押せる状態なので、二重送信できてしまいます。押したら無効にしてください',
      item: 'a18',
    },

    { speaker: 'self', gap: 3900, text: 'あとはダッシュボードか', item: null },

    {
      speaker: 'self',
      gap: 2000,
      text: 'グラフの軸のラベルが縦書きで読みにくいです。横に寝かせるか、斜めにしてください',
      item: 'a19',
      cues: [
        { type: 'nav', at: -800, url: 'http://localhost:3000/dashboard', title: 'ダッシュボード | Acme', viewport: 1280 },
        { type: 'pen', at: 1200, id: 'p7', durationMs: 1400, bbox: [120, 300, 60, 220], selector: 'g.y-axis' },
      ],
    },

    {
      speaker: 'self',
      gap: 4000,
      text: 'スマホ幅にすると表が横にはみ出して、右端が見えません。横スクロールできるようにしてください',
      item: 'a20',
      cues: [{ type: 'nav', at: -900, url: 'http://localhost:3000/dashboard', title: 'ダッシュボード | Acme', viewport: 390 }],
    },

    { speaker: 'self', gap: 3800, text: 'はい、以上です', item: null },
  ],
  expected: [
    { id: 'a1', gist: 'トップのヒーロー見出しを大きく・太字にする', status: 'decided' },
    { id: 'a2', gist: '「無料で始める」ボタンを濃い青にして押せると分かるようにする', status: 'decided' },
    { id: 'a3', gist: 'ボタン下の注意書きの文字色を濃くする', status: 'decided' },
    { id: 'a4', gist: 'ヘッダーのロゴを内側へ寄せる', status: 'decided' },
    { id: 'a5', gist: '機能カードの余白を詰めて高さを揃える', status: 'decided' },
    { id: 'a6', gist: '機能カードのアイコンを機能ごとに色分けする', status: 'decided' },
    { id: 'a7', gist: 'お客様の声の顔写真を丸く切り抜く', status: 'decided' },
    { id: 'a8', gist: '月額／年額トグルを大きくし、選択中を色で示す', status: 'decided' },
    { id: 'a9', gist: 'プラン名「スタンダード」を「プロ」に変える', status: 'decided' },
    { id: 'a10', gist: '真ん中のプランにおすすめバッジと太い枠線を付ける', status: 'decided' },
    { id: 'a11', gist: '申し込むボタンを真ん中だけ塗り、両脇は枠線にする', status: 'decided' },
    { id: 'a12', gist: '価格の単位表記を「月額」に統一する', status: 'decided' },
    { id: 'a13', gist: '価格の横に「税抜」を入れる', status: 'decided' },
    { id: 'a14', gist: 'FAQアコーディオンの開くアニメーションを速くする', status: 'decided' },
    { id: 'a15', gist: '入力欄のラベルを欄の上に出す', status: 'decided' },
    { id: 'a16', gist: 'パスワードの条件を最初から表示する', status: 'decided' },
    { id: 'a17', gist: 'エラー表示で欄の枠も赤くし、アイコンを付ける', status: 'decided' },
    { id: 'a18', gist: '送信ボタンを押したら無効にして二重送信を防ぐ', status: 'decided' },
    { id: 'a19', gist: 'グラフのY軸ラベルを横または斜めにする', status: 'decided' },
    { id: 'a20', gist: 'スマホ幅で表を横スクロールできるようにする', status: 'decided' },
  ],
};
