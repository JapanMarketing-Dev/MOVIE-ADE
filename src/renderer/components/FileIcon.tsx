import {
  BookOpen, Bot, Boxes, Braces, Component, Container, Database, FileArchive, FileAudio, FileBox, FileCode, FileCog, FileImage, FileJson, FileKey, FileLock,
  FileSpreadsheet, FileTerminal, FileText, FileVideo, FlaskConical, Folder, FolderArchive, FolderCode, FolderCog, FolderGit2, FolderKey, FolderOpen, GitBranch,
  Globe, Images, KeyRound, Languages, Lock, Package, Palette, Scale, ScrollText, Server, Terminal, Webhook, Workflow, Wrench, type LucideIcon
} from 'lucide-react'
import { fileIconFor, folderIconFor, type FileIconName } from '../lib/fileIcons'

/** lib/fileIcons.ts の名前 → lucide の部品 */
const ICONS: Record<FileIconName, LucideIcon> = {
  Folder, FolderOpen, FolderCode, FolderCog, FolderGit2, FolderArchive, FolderKey,
  BookOpen, Server, FlaskConical, Terminal, Images, Globe, Component, Bot, Package, Database,
  Webhook, Palette, Languages, Braces, Wrench, Boxes, Workflow,
  FileText, FileCode, FileJson, FileCog, FileTerminal, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileKey, FileLock, FileBox, Lock, KeyRound, GitBranch, Container, Scale, ScrollText
}

/** ファイルツリーの1行のアイコン（名前・拡張子で形と色を変える） */
export function FileIcon({ name, kind, open = false, size = 13 }: { name: string; kind: 'file' | 'directory'; open?: boolean; size?: number }) {
  const spec = kind === 'directory' ? folderIconFor(name, open) : fileIconFor(name)
  const Icon = ICONS[spec.icon]
  return <Icon size={size} aria-hidden="true" className={`file-icon${spec.tone ? ` file-icon--${spec.tone}` : ''}`} />
}
