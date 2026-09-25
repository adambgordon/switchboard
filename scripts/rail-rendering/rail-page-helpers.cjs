// Page-side helpers for the rail check, injected once into the fixture page as `window.__rail`. Kept as a
// plain function so it can be serialized with toString(); it must not close over anything.
module.exports = function installRailHelpers() {
  const body = () => document.querySelector('.sb-rail-body')
  const keyOf = (el) => el.dataset.key ?? el.dataset.session ?? el.getAttribute('aria-label') ?? el.className
  const box = () => {
    const b = body(), r = b.getBoundingClientRect()
    const top = r.top + b.clientTop, left = r.left + b.clientLeft
    return {
      top, left, bottom: top + b.clientHeight, right: left + b.clientWidth, width: b.clientWidth,
      scrollTop: b.scrollTop, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight,
      maxScroll: b.scrollHeight - b.clientHeight
    }
  }
  // A unit's box in the body's CONTENT coordinates (unaffected by scrolling), plus its viewport rect.
  const place = (el) => {
    const b = box(), r = el.getBoundingClientRect()
    return { key: keyOf(el), top: r.top - b.top + b.scrollTop, height: r.height, rect: r.toJSON() }
  }
  const shiftOf = (el) => (el.style.transform ? new DOMMatrix(el.style.transform).m42 : 0)
  const unitsOf = (block) => block === 'folders'
    ? [...body().querySelectorAll(':scope > section.sb-group')]
    : [...body().querySelectorAll(`.sb-block[data-block="${CSS.escape(block)}"] > .sb-row`)]
  // Escape keydowns the page actually received (the drag hook's own capture listener stops propagation
  // but not other window listeners), so a dropped synthetic key reads as a harness fault, not a product one.
  window.escapes = 0
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.escapes++ }, true)
  window.__rail = {
    // What a point would hit: which row, and whether a folder's collapse toggle.
    hitAt: (x, y) => {
      const el = document.elementFromPoint(x, y)
      const row = el && el.closest('.sb-rail-body .sb-row')
      const toggle = el && el.closest('.sb-group-toggle')
      return { row: row ? keyOf(row) : null, toggle: toggle ? toggle.closest('section.sb-group')?.dataset.key ?? null : null }
    },
    box,
    units: (block) => unitsOf(block).map(place),
    unitRect: (block, key) => {
      const el = unitsOf(block).find((u) => keyOf(u) === key)
      if (!el) return null
      const handle = block === 'folders' ? el.querySelector(':scope > .sb-group-head') : el
      return { unit: el.getBoundingClientRect().toJSON(), handle: handle.getBoundingClientRect().toJSON() }
    },
    // Scroll so a unit's handle sits `offset` px below the body's visible top.
    reveal: (block, key, offset) => {
      const el = unitsOf(block).find((u) => keyOf(u) === key)
      const b = box(), r = el.getBoundingClientRect()
      body().scrollTop = Math.max(0, r.top - b.top + b.scrollTop - offset)
      return body().scrollTop
    },
    scrollTo: (y) => { body().scrollTop = y; return body().scrollTop },
    // The drop index the gap currently shows, read back from the siblings' translations: every sibling
    // shifted up sits between the old slot and the gap below it, every one shifted down above.
    gapIndex: (block, from) => {
      const shifts = unitsOf(block).map(shiftOf)
      let index = from
      shifts.forEach((s, i) => {
        if (i === from) return
        if (s < -0.5) index++
        else if (s > 0.5) index--
      })
      return { index, shifts }
    },
    state: () => {
      const all = [...body().querySelectorAll('.sb-row, section.sb-group, .sb-group-head, .sb-block')]
      const clones = [...document.querySelectorAll('.sb-drag-clone')]
      return {
        dragging: document.body.classList.contains('sb-dragging-row'),
        clones: clones.length,
        // Under <body> in a .sb-drag-host, outside the real rail (the host carries the rail's classes).
        clonesHosted: clones.every((c) => {
          const host = c.closest('.sb-drag-host')
          return !!host && host.parentElement === document.body && !body().contains(c) &&
            (getComputedStyle(c).position === 'fixed' || getComputedStyle(host).position === 'fixed')
        }),
        cloneRects: clones.map((c) => c.getBoundingClientRect().toJSON()),
        hidden: all.filter((el) => el.style.visibility === 'hidden' || (getComputedStyle(el).visibility === 'hidden' &&
          !el.parentElement.closest('[style*="visibility"]'))).map(keyOf),
        transformed: all.filter((el) => el.style.transform && el.style.transform !== 'none').map((el) => keyOf(el) + ':' + el.style.transform),
        scrollTop: body().scrollTop,
        calls: window.dropCalls.length,
        errors: window.auditErrors.slice()
      }
    },
    visibility: (block, key) => {
      const el = unitsOf(block).find((u) => keyOf(u) === key)
      return el ? getComputedStyle(el).visibility : null
    },
    // The folder clone's header, for the "header stays painted" check.
    cloneHead: () => {
      const clone = document.querySelector('.sb-drag-clone')
      const head = clone && (clone.matches('.sb-group-head') ? clone : clone.querySelector('.sb-group-head'))
      const label = head && head.querySelector('.sb-group-label-text')
      if (!head || !label) return null
      const hs = getComputedStyle(head)
      return {
        head: head.getBoundingClientRect().toJSON(), label: label.getBoundingClientRect().toJSON(),
        text: label.textContent, visibility: hs.visibility, opacity: Number(hs.opacity),
        background: hs.backgroundColor.match(/[\d.]+/g).map(Number), ink: getComputedStyle(label).color.match(/[\d.]+/g).map(Number)
      }
    },
    menuButton: (key) => {
      const row = body().querySelector(`.sb-row[data-key="${CSS.escape(key)}"], .sb-row[data-session="${CSS.escape(key)}"]`)
      const btn = row && row.querySelector('.sb-row-menu-btn')
      return btn ? { rect: btn.getBoundingClientRect().toJSON(), noDrag: btn.hasAttribute('data-no-drag'),
        opacity: Number(getComputedStyle(btn).opacity), pointerEvents: getComputedStyle(btn).pointerEvents } : null
    },
    rowRect: (key) => {
      const row = body().querySelector(`.sb-row[data-key="${CSS.escape(key)}"], .sb-row[data-session="${CSS.escape(key)}"]`)
      return row ? row.getBoundingClientRect().toJSON() : null
    },
    // The folder drag's reshaping. The fold keeps the dragged folder's rows in the DOM: it pins that
    // section to its header's height (inline style.height, `sb-folded`, clipped) and fades the rest to
    // opacity 0, animating the height. So "folded" is measured as geometry plus opacity, never display.
    folderShape: () => {
      const headFull = (g) => {
        const h = g.querySelector(':scope > .sb-group-head')
        if (!h) return 0
        const cs = getComputedStyle(h)
        return h.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)
      }
      const describe = (g) => {
        const rest = [...g.children].filter((c) => !c.matches('.sb-group-head'))
        const opacities = rest.map((c) => Number(getComputedStyle(c).opacity))
        return {
          key: g.dataset.key, folded: g.classList.contains('sb-folded'),
          height: g.getBoundingClientRect().height, headFull: headFull(g), inlineHeight: g.style.height,
          overflowY: getComputedStyle(g).overflowY, rest: rest.length,
          maxOpacity: opacities.length ? Math.max(...opacities) : 0,
          // Blocks only: Show more / Show less is transparent at rest (it shows on hover).
          minOpacity: Math.min(1, ...rest.filter((c) => c.matches('.sb-block')).map((c) => Number(getComputedStyle(c).opacity)))
        }
      }
      const sections = [...body().querySelectorAll(':scope > section.sb-group')]
      const clone = document.querySelector('.sb-drag-clone')
      let cloneInfo = null
      if (clone) {
        const cr = clone.getBoundingClientRect()
        const g = clone.matches('section') ? clone : clone.querySelector('section')
        // A clone row shows only if it is opaque AND inside the clone's clipped box.
        const shown = [...clone.querySelectorAll('.sb-block, .sb-rail-more-row')].filter((e) => {
          const r = e.getBoundingClientRect()
          const inside = r.height > 0 && r.bottom > cr.top + 0.5 && r.top < cr.bottom - 0.5
          return inside && Number(getComputedStyle(e).opacity) > 0.01
        }).map((e) => e.dataset.block ?? e.className)
        cloneInfo = { rect: cr.toJSON(), overflow: getComputedStyle(clone).overflow, headFull: g ? headFull(g) : null, shown,
          folded: !!g && g.classList.contains('sb-folded') }
      }
      return {
        lifted: body().classList.contains('sb-folder-drag'),
        sections: sections.map(describe),
        folds: sections.flatMap((g) => g.getAnimations()).filter((a) => a.id === 'sb-fold' && a.playState !== 'finished' && a.playState !== 'idle').length,
        clone: cloneInfo
      }
    },
    headTop: (key) => {
      const g = [...body().querySelectorAll(':scope > section.sb-group')].find((s) => s.dataset.key === key)
      const h = g && g.querySelector(':scope > .sb-group-head')
      return h ? { head: h.getBoundingClientRect().top, section: g.getBoundingClientRect().top } : null
    },
    // Text boxes, real and cloned: the row's title, and a folder header's label.
    rowTitle: (key) => {
      const row = body().querySelector(`.sb-row[data-key="${CSS.escape(key)}"], .sb-row[data-session="${CSS.escape(key)}"]`)
      const t = row && row.querySelector('.sb-row-title')
      return t ? t.getBoundingClientRect().toJSON() : null
    },
    cloneTitle: () => {
      const t = document.querySelector('.sb-drag-clone .sb-row-title')
      return t ? t.getBoundingClientRect().toJSON() : null
    },
    headLabel: (key) => {
      const g = [...body().querySelectorAll(':scope > section.sb-group')].find((s) => s.dataset.key === key)
      const l = g && g.querySelector(':scope > .sb-group-head .sb-group-label-text')
      return l ? l.getBoundingClientRect().toJSON() : null
    },
    cloneLabel: () => {
      const l = document.querySelector('.sb-drag-clone .sb-group-label-text')
      return l ? l.getBoundingClientRect().toJSON() : null
    },
    selectedKey: () => {
      const row = body().querySelector('.sb-row.selected')
      return row ? keyOf(row) : null
    },
    ring: (key) => {
      const row = body().querySelector(`.sb-row[data-key="${CSS.escape(key)}"], .sb-row[data-session="${CSS.escape(key)}"]`)
      const rs = getComputedStyle(row)
      const rail = document.querySelector('.sb-rail')
      const shadow = rs.boxShadow
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number)
      return {
        dpr: devicePixelRatio, row: row.getBoundingClientRect().toJSON(), clip: box(), selected: row.classList.contains('selected'),
        shadow, ring: rgb(shadow), inside: rgb(rs.backgroundColor), outside: rgb(getComputedStyle(rail).backgroundColor)
      }
    }
  }
}
