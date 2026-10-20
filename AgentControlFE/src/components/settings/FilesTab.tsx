import { useCallback, useEffect, useRef, useState } from 'react'
import Dialog from '../Dialog'
import ConfirmDialog from '../ConfirmDialog'
import { apiUrl, putRaw, request, serverMessage } from '../../lib/api'
import { botFolder } from '../../lib/agent-put'
import { rowFocusTarget } from '../../lib/dialog-focus'
import {
  ancestorsOf,
  breadcrumb,
  canModify,
  canWriteInto,
  checkPath,
  fileContentPath,
  fileIcon,
  fileSize,
  fileTarget,
  filesApi,
  fileWhen,
  folderLine,
  imageLine,
  joinPath,
  latestSubfolder,
  filesTotal,
  nameError,
  paneView,
  parentOf,
  treeEntries,
  treeSize,
  usageView,
  zoneBadge,
  zoneOfPath,
} from '../../lib/files'
import type { Agent, FileEntry, FileListing } from '../../lib/types'

const files = filesApi(request, putRaw, serverMessage)

type Props = {
  agent: Agent
  /** Raw `?path=` (checked here; a refused path is never requested). */
  path: string
  onPath: (path: string) => void
  /** GAP-F2: the latest listing's `totalFiles` (whole folder; undefined when the BE leaves it out). */
  onTotal?: (total: number | undefined) => void
}

type Loaded = Record<string, FileListing>
type Busy = { text: string } | null

const errText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

/** FE-4 Files tab (mockup 03d) on BE-2. Gaps are listed in lib/files.ts (GAP-F1…). */
export default function FilesTab({ agent, path: rawPath, onPath, onTotal }: Props) {
  const checked = checkPath(rawPath)
  /** ?path= after the guard: a folder, or a file (FE-7 Open: show its folder with the file picked out). */
  const target = checked.ok ? checked.path : 'shared'
  const [loaded, setLoaded] = useState<Loaded>({})
  const [listError, setListError] = useState<{ path: string; message: string } | null>(null)
  // Tree: shared/ and the open folder's ancestors start expanded; the user can open or close any folder.
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState(false)
  const [renaming, setRenaming] = useState<FileEntry | null>(null)
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadedRef = useRef<Loaded>({})
  const paneRef = useRef<HTMLElement>(null)
  const treeRef = useRef<HTMLElement>(null)
  /** The row a Rename/Delete dialog was opened from (its ⋯ menu item is gone by close time). */
  const menuOrigin = useRef<{ path: string; index: number } | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const fileHit = target !== '' && fileTarget(loaded[parentOf(target)], target)
  /** The folder on show. */
  const path = fileHit ? parentOf(target) : target
  const slug = botFolder(agent.slug)?.replace(/^bots\//, '').replace(/\/$/, '') || agent.slug || agent.name

  const fetchOne = useCallback(
    async (dir: string) => {
      try {
        const listing = await files.list(agent.id, dir)
        loadedRef.current = { ...loadedRef.current, [dir]: listing }
        setLoaded(loadedRef.current)
        // GAP-F2: totalFiles counts the whole folder (same on every path); the latest listing wins.
        onTotal?.(filesTotal(listing))
        setListError((e) => (e?.path === dir ? null : e))
        return listing
      } catch (err) {
        setListError({ path: dir, message: errText(err, 'Could not load this folder.') })
        return null
      }
    },
    [agent.id, onTotal],
  )

  const load = useCallback(
    async (dir: string) => {
      const listing = await fetchOne(dir)
      // Counts for folder rows and cards (03d "9", "9 items"): one level down, writable zones only.
      if (listing && canWriteInto(dir)) {
        await Promise.all(listing.entries.filter((e) => e.kind === 'dir').slice(0, 30).map((d) => fetchOne(d.path)))
      }
    },
    [fetchOne],
  )

  const refresh = useCallback(
    async (dirs: string[]) => {
      await Promise.all([...new Set(['', ...dirs])].map((d) => load(d)))
    },
    [load],
  )

  // `target` is always safe here: a refused ?path= falls back to shared/ and is never requested.
  // The parent is listed first, so a file target (FE-7 Open) is never requested as a folder.
  useEffect(() => {
    void (async () => {
      await refresh(['shared', 'workspace', ...ancestorsOf(parentOf(target))])
      if (target !== '' && !fileTarget(loadedRef.current[parentOf(target)], target)) await load(target)
    })()
  }, [target, refresh, load])

  // FE-7 Open: bring the picked-out file into view once its folder is listed.
  useEffect(() => {
    if (!fileHit) return
    paneRef.current?.querySelector(`[data-fpath="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [fileHit, target])

  // Narrow (stacked) layout clips the tree: keep the open folder's row visible inside it,
  // scrolling only the tree list, never the panel.
  useEffect(() => {
    const row = treeRef.current?.querySelector<HTMLElement>('.cf-tree__row--on')
    const list = treeRef.current?.querySelector<HTMLElement>(':scope > .cf-tree')
    if (!row || !list || list.scrollHeight <= list.clientHeight) return
    const r = row.getBoundingClientRect(), l = list.getBoundingClientRect()
    if (r.top < l.top) list.scrollTop -= l.top - r.top
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom
  }, [path, loaded])

  /** Focus fallback for Rename/Delete opened from a row's ⋯ menu (lib/dialog-focus rowFocusTarget). */
  const menuReturnFocus = () => {
    const pane = paneRef.current
    const origin = menuOrigin.current
    if (!pane || !origin) return null
    const rows = Array.from(pane.querySelectorAll<HTMLElement>('[data-fpath]')).map((el) => ({
      key: el.dataset.fpath ?? '',
      el: el.querySelector<HTMLElement>('.cf-fmenu__btn'),
    }))
    return rowFocusTarget(rows, origin.path, origin.index, pane)
  }
  const rowIndex = (p: string) =>
    Array.from(paneRef.current?.querySelectorAll<HTMLElement>('[data-fpath]') ?? []).findIndex((el) => el.dataset.fpath === p)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.cf-fmenu')) setMenu(null)
    }
    // Esc closes the menu wherever focus is (the ⋯ button too) without closing the panel:
    // BotSettingsPanel ignores an Esc whose default was prevented.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc, true)
    }
  }, [menu])

  const current = loaded[path]
  const writable = canWriteInto(path)
  const view = current ? paneView(current.entries, path, query) : null
  const usage = usageView(loaded['']?.usage ?? current?.usage)
  const countOf = (dir: string) => loaded[dir]?.entries.length

  const go = (p: string) => {
    setMenu(null)
    setQuery('')
    onPath(p)
  }
  // Default-open: shared/, workspace/ and its latest subfolder (03d), and the open folder's ancestors.
  const autoOpen = loaded.workspace ? latestSubfolder('workspace', loaded.workspace.entries, loaded) : null
  const isOpen = (dir: string) =>
    !!loaded[dir] &&
    !collapsed.has(dir) &&
    (opened.has(dir) || dir === 'shared' || dir === 'workspace' || dir === autoOpen || ancestorsOf(path).includes(dir))
  const setOpen = (dir: string, open: boolean) => {
    setOpened((s) => { const n = new Set(s); if (open) n.add(dir); else n.delete(dir); return n })
    setCollapsed((s) => { const n = new Set(s); if (open) n.delete(dir); else n.add(dir); return n })
  }
  const toggle = (dir: string) => {
    if (dir !== path) {
      setOpen(dir, true)
      go(dir)
      return
    }
    setOpen(dir, !isOpen(dir))
  }

  const upload = async (list: FileList | File[]) => {
    const items = Array.from(list)
    if (items.length === 0) return
    if (!writable) {
      setActionError('Files can only be added to shared/ or workspace/.')
      return
    }
    setActionError(null)
    const failed: string[] = []
    for (let i = 0; i < items.length; i++) {
      setBusy({ text: `Uploading ${items[i].name}${items.length > 1 ? ` (${i + 1} of ${items.length})` : ''}…` })
      try {
        await files.upload(agent.id, path, items[i])
      } catch (err) {
        failed.push(errText(err, `Could not upload "${items[i].name}".`))
      }
    }
    setBusy(null)
    if (failed.length) setActionError(failed.join(' '))
    await refresh([path, parentOf(path)])
  }

  /** Runs a change; its error goes to the panel's alert line, or into the open dialog when `inDialog`. */
  const act = async (label: string, fn: () => Promise<unknown>, reloadDirs: string[], inDialog = false) => {
    setActionError(null)
    setDialogError(null)
    setBusy({ text: label })
    try {
      await fn()
      return true
    } catch (err) {
      if (inDialog) setDialogError(errText(err, 'That did not work.'))
      else setActionError(errText(err, 'That did not work.'))
      return false
    } finally {
      setBusy(null)
      await refresh(reloadDirs)
    }
  }

  const contentUrl = (p: string, download = false) => apiUrl(fileContentPath(agent.id, p, download))

  const menuFor = (e: FileEntry) => (
    <span className="cf-fmenu">
      <button
        type="button"
        className="cf-fmenu__btn"
        aria-label={`Actions for ${e.name}`}
        aria-haspopup="menu"
        aria-expanded={menu === e.path}
        onClick={() => setMenu((m) => (m === e.path ? null : e.path))}
      >
        ⋯
      </button>
      {menu === e.path && (
        <span
          className="cf-fmenu__list"
          role="menu"
        >
          {e.kind === 'dir' ? (
            <button type="button" role="menuitem" onClick={() => go(e.path)}>
              Open
            </button>
          ) : (
            <>
              <a role="menuitem" href={contentUrl(e.path)} target="_blank" rel="noopener noreferrer" onClick={() => setMenu(null)}>
                Open
              </a>
              <a role="menuitem" href={contentUrl(e.path, true)} download={e.name} onClick={() => setMenu(null)}>
                Download
              </a>
            </>
          )}
          {canModify(e.path) && (
            <>
              <button type="button" role="menuitem" onClick={() => { menuOrigin.current = { path: e.path, index: rowIndex(e.path) }; setMenu(null); setDialogError(null); setRenaming(e) }}>
                Rename…
              </button>
              <button type="button" role="menuitem" onClick={() => { menuOrigin.current = { path: e.path, index: rowIndex(e.path) }; setMenu(null); setDeleting(e) }}>
                Delete…
              </button>
            </>
          )}
        </span>
      )}
    </span>
  )

  const treeRows = (dir: string, depth: number): React.ReactNode[] => {
    const listing = loaded[dir]
    if (!listing) return []
    return treeEntries(dir, listing.entries).flatMap((e) => {
      const pad = { paddingLeft: 8 + depth * 16 }
      const badge = depth === 0 ? zoneBadge(e) : null
      const badgeEl = badge && <span className={`cf-zone cf-zone--${badge.tone}`}>{badge.label}</span>
      if (e.kind === 'dir') {
        const open = isOpen(e.path)
        const count = countOf(e.path)
        return [
          <li key={e.path}>
            <button
              type="button"
              className={`cf-tree__row${e.path === path ? ' cf-tree__row--on' : ''}`}
              style={pad}
              aria-expanded={open}
              aria-current={e.path === path ? 'true' : undefined}
              onClick={() => toggle(e.path)}
            >
              <span className="cf-tree__ico" aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span className="cf-tree__name">{e.name}</span>
              <span className="cf-tree__sp" />
              {badgeEl ?? (count !== undefined && (!open || depth === 0) && <span className="cf-tree__meta">{count}</span>)}
            </button>
          </li>,
          ...(open ? treeRows(e.path, depth + 1) : []),
        ]
      }
      return [
        <li key={e.path}>
          <a className="cf-tree__row" style={pad} href={contentUrl(e.path)} target="_blank" rel="noopener noreferrer" title={`Open ${e.name}`}>
            <span className="cf-tree__ico" aria-hidden="true">{fileIcon(e)}</span>
            <span className="cf-tree__name cf-tree__name--file">{e.name}</span>
            <span className="cf-tree__sp" />
            {badgeEl ?? <span className="cf-tree__meta">{treeSize(e)}</span>}
          </a>
        </li>,
      ]
    })
  }

  const crumbs = breadcrumb(slug, path)
  const zone = zoneOfPath(path)

  return (
    <div className="cf-files">
      <div className="cf-files__bar">
        {/* GAP-F1: Shared opens shared/, All files opens the folder root. */}
        <div className="cf-files__seg" role="group" aria-label="Show">
          <button type="button" className={zone === 'shared' ? 'is-on' : ''} aria-pressed={zone === 'shared'} onClick={() => go('shared')}>
            Shared by you
          </button>
          <button type="button" className={zone !== 'shared' ? 'is-on' : ''} aria-pressed={zone !== 'shared'} onClick={() => go('')}>
            All files
          </button>
        </div>
        <label className="cf-search cf-search--boxed cf-grow">
          <span aria-hidden="true">⌕</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files" aria-label="Search files in this folder" />
        </label>
        <button type="button" className="cf-btn" disabled={!writable || !!busy} title={writable ? undefined : 'Open shared/ or workspace/ to upload'} onClick={() => inputRef.current?.click()}>
          ⤒ Upload
        </button>
        <button type="button" className="cf-btn" disabled={!writable || !!busy} title={writable ? undefined : 'Open shared/ or workspace/ to add a folder'} onClick={() => { setDialogError(null); setNewFolder(true) }}>
          ＋ Folder
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.target.files
            if (list) void upload(Array.from(list))
            e.target.value = ''
          }}
        />
      </div>

      <div className="cf-files__info">
        <span aria-hidden="true">🔒</span>
        <span>
          Private to {agent.name}; no other bot can see it. {agent.name} reads everything here. Its scripts can write only to workspace/. memory/ and BOT.md are managed by AgentControl, and skills/ is read-only.
        </span>
      </div>

      {/* GAP-F8, GAP-F13: one status / alert line. */}
      {!checked.ok && <p className="field__err cf-files__msg" role="alert">{checked.error} Showing shared/ instead.</p>}
      {busy && <p className="cf-files__msg cf-files__msg--busy" role="status">{busy.text}</p>}
      {actionError && <p className="field__err cf-files__msg" role="alert">{actionError}</p>}

      <div className="cf-files__cols">
        <nav className="cf-files__tree" aria-label="Bot folder" ref={treeRef}>
          <div className="cf-files__root">{botFolder(agent.slug) ?? `bots/${slug}/`}</div>
          <ul className="cf-tree">{treeRows('', 0)}</ul>
          <div className="cf-tree__sp" />
          {usage && (
            <div className="cf-files__usage">
              <div className="cf-files__usebar" role="meter" aria-label="Folder space used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.percent)}>
                <div style={{ width: `${usage.percent}%` }} />
              </div>
              <div className="cf-files__uselabel">{usage.label}</div>
            </div>
          )}
        </nav>

        <section
          ref={paneRef}
          tabIndex={-1}
          className={`cf-files__pane${dragging ? ' cf-files__pane--drop' : ''}`}
          aria-label="Folder contents"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            setDragging(false)
            void upload(e.dataTransfer.files)
          }}
        >
          <div className="cf-files__crumbs">
            {crumbs.map((c, i) => (
              <span key={c.path} className="cf-files__crumb">
                {i > 0 && <span className="cf-files__sep" aria-hidden="true">/</span>}
                {i === crumbs.length - 1 ? (
                  <b aria-current="page">{c.label}</b>
                ) : (
                  <button type="button" onClick={() => go(c.path)}>{c.label}</button>
                )}
              </span>
            ))}
            <span className="cf-tree__sp" />
            {path === 'shared' && <span className="cf-files__note">Files you sent {agent.name} in chat · newest first</span>}
          </div>

          {listError?.path === path && <p className="field__err" role="alert">{listError.message}</p>}
          {!current && listError?.path !== path && <p className="cf-files__empty">Loading…</p>}
          {view && view.images.length + view.folders.length + view.files.length === 0 && (
            <p className="cf-files__empty">{query ? 'No files match.' : 'This folder is empty.'}</p>
          )}

          {view && view.images.length > 0 && (
            <>
              <div className="cf-files__lbl">Images</div>
              <div className="cf-files__imgs">
                {view.images.map((e) => (
                  <div key={e.path} className={`cf-files__img${fileHit && e.path === target ? ' cf-files__hit' : ''}`} data-fpath={e.path}>
                    <a href={contentUrl(e.path)} target="_blank" rel="noopener noreferrer" className="cf-files__thumb" aria-label={`Open ${e.name}`}>
                      <img src={contentUrl(e.path)} alt="" loading="lazy" />
                    </a>
                    <div className="cf-files__imgname">
                      <span title={e.name}>{e.name}</span>
                      {menuFor(e)}
                    </div>
                    <div className="cf-files__imgmeta">{imageLine(e)}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {view && view.folders.length > 0 && (
            <>
              <div className="cf-files__lbl">Folders</div>
              <div className="cf-files__dirs">
                {view.folders.map((e) => (
                  <div key={e.path} className="cf-files__dir" data-fpath={e.path}>
                    <button type="button" className="cf-files__dirbtn" onClick={() => go(e.path)}>
                      <span className="cf-files__dirico" aria-hidden="true">🗂</span>
                      <span className="cf-files__dirtxt">
                        <span className="cf-files__dirname">{e.name}</span>
                        <span className="cf-files__dirmeta">{folderLine(e, countOf(e.path))}</span>
                      </span>
                    </button>
                    {canModify(e.path) && menuFor(e)}
                  </div>
                ))}
              </div>
            </>
          )}

          {view && view.files.length > 0 && (
            <>
              <div className="cf-files__lbl">Files</div>
              <ul className="cf-files__list">
                {view.files.map((e) => (
                  <li key={e.path} className={`cf-files__row${fileHit && e.path === target ? ' cf-files__hit' : ''}`} data-fpath={e.path} aria-current={fileHit && e.path === target ? 'true' : undefined}>
                    <span className="cf-files__rowico" aria-hidden="true">{fileIcon(e)}</span>
                    <a className="cf-files__rowname" href={contentUrl(e.path)} target="_blank" rel="noopener noreferrer" title={e.name}>
                      {e.name}
                    </a>
                    <span className="cf-tree__sp" />
                    <span className="cf-files__rowwhen">{fileWhen(e)}</span>
                    <span className="cf-files__rowsize">{fileSize(e)}</span>
                    {menuFor(e)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {path === 'shared' && <p className="cf-files__hint">Drop files here, or send them in chat, to share them with {agent.name}.</p>}
        </section>
      </div>

      <NameDialog
        open={newFolder}
        title="New folder"
        label="Folder name"
        action="Create folder"
        initial=""
        onClose={() => setNewFolder(false)}
        serverError={newFolder ? dialogError : null}
        onTyping={() => setDialogError(null)}
        onSubmit={async (name) => {
          // Errors stay in the dialog (role=alert), with the name still filled in.
          const ok = await act(`Creating ${name}…`, () => files.makeFolder(agent.id, joinPath(path, name)), [path], true)
          if (ok) setNewFolder(false)
          return ok
        }}
      />
      <NameDialog
        open={renaming !== null}
        title={renaming ? `Rename ${renaming.name}` : 'Rename'}
        label="New name"
        action="Rename"
        initial={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        returnFocus={menuReturnFocus}
        serverError={renaming ? dialogError : null}
        onTyping={() => setDialogError(null)}
        onSubmit={async (name) => {
          if (!renaming) return false
          const from = renaming.path
          const to = joinPath(parentOf(from), name)
          // Errors (e.g. a 400 for a symlink name) stay in the dialog with the name still filled in.
          const ok = await act(`Renaming ${renaming.name}…`, () => files.move(agent.id, from, to), [parentOf(from)], true)
          if (ok) {
            // Focus returns to the row under its new name (it may have re-sorted).
            if (menuOrigin.current?.path === from) menuOrigin.current = { ...menuOrigin.current, path: to }
            setRenaming(null)
            if (path === from || path.startsWith(`${from}/`)) go(to + path.slice(from.length))
          }
          return ok
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.name}?` : 'Delete?'}
        subtitle="It moves to this bot's trash in the archive; it is not erased."
        confirmLabel="Delete"
        loading={!!busy}
        onCancel={() => setDeleting(null)}
        returnFocus={menuReturnFocus}
        onConfirm={async () => {
          if (!deleting) return
          const doomed = deleting
          const ok = await act(`Deleting ${doomed.name}…`, () => files.remove(agent.id, doomed.path), [parentOf(doomed.path)])
          setDeleting(null)
          if (ok && (path === doomed.path || path.startsWith(`${doomed.path}/`))) go(parentOf(doomed.path))
        }}
      />
    </div>
  )
}

/** GAP-F6: one name field for New folder and Rename. */
function NameDialog({ open, title, label, action, initial, onClose, onSubmit, serverError, onTyping, returnFocus }: {
  open: boolean
  title: string
  label: string
  action: string
  initial: string
  onClose: () => void
  /** Resolves true when done (the dialog closes), false when it failed and stays open. */
  onSubmit: (name: string) => Promise<boolean>
  /** The server's message for a failed submit, shown in the dialog (role=alert). */
  serverError?: string | null
  onTyping?: () => void
  returnFocus?: () => HTMLElement | null
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = error ?? serverError ?? null
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(initial)
      setError(null)
    }
  }
  return (
    <Dialog open={open} title={title} size="sm" onClose={onClose} returnFocus={returnFocus}>
      <form
        className="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault()
          const bad = nameError(name)
          if (bad) {
            setError(bad)
            return
          }
          setSaving(true)
          const done = await onSubmit(name.trim())
          setSaving(false)
          // Failed: keep the dialog, the name and the server's message; focus back on the field.
          if (!done) requestAnimationFrame(() => inputRef.current?.focus())
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="cf-files-name">{label}</label>
          <input
            id="cf-files-name"
            ref={inputRef}
            className={`input${shown ? ' input--invalid' : ''}`}
            value={name}
            data-autofocus
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? 'cf-files-name-err' : undefined}
            onChange={(e) => { setName(e.target.value); setError(null); onTyping?.() }}
          />
          {shown && <p className="field__err" id="cf-files-name-err" role="alert">{shown}</p>}
        </div>
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Working…' : action}</button>
        </div>
      </form>
    </Dialog>
  )
}
