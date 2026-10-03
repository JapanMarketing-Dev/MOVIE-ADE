// Vite の ?raw（ファイルの中身を文字列として埋め込む）。electron-vite/node の型には無いので足す
declare module '*?raw' {
  const content: string
  export default content
}
