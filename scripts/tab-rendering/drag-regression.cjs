const assert = require('node:assert/strict')

module.exports = async function checkDragScrolling(win) {
  const results = [], failures = []
  const js = source => win.webContents.executeJavaScript(source)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const mouse = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
  })
  const geometry = index => js(`(() => {
    const el=document.querySelectorAll('.sb-tabstrip')[${index}], r=el.getBoundingClientRect();
    return { left:r.left+1, right:r.right-1, y:r.top+r.height/2,
      scroll:el.scrollLeft, limit:el.scrollWidth-el.clientWidth };
  })()`)
  for (const theme of ['light', 'dark']) for (const step of [0, 1, 3]) for (const direction of [-1, 1]) {
    win.webContents.setZoomLevel(step / 2)
    win.setContentSize(860, 850)
    await js(`window.configure({theme:${JSON.stringify(theme)},count:16,layout:'scroll',activeIndex:0,secondary:false})`)
    await js('document.fonts.ready'); await settle()
    await js(`document.querySelector('.sb-tabstrip').scrollLeft=${direction < 0 ? '1e9' : '0'}`)
    await settle()
    const start = await js(`(() => {
      const el=document.querySelector('.sb-tabstrip'), box=el.getBoundingClientRect();
      const tab=[...el.querySelectorAll('.sb-tab')].find(tab=>{const r=tab.getBoundingClientRect();return r.left>box.left+30&&r.right<box.right-30});
      if(!tab) throw new Error('No visible source tab');
      const r=tab.getBoundingClientRect(); return {x:r.left+15,y:r.top+r.height/2};
    })()`)
    await mouse('mouseMoved', start.x, start.y)
    await mouse('mousePressed', start.x, start.y)
    let held
    for (let width = 860; width <= 876; width++) {
      if (width !== 860) { win.setContentSize(width, 850); await settle() }
      const box = await geometry(0)
      await mouse('mouseMoved', direction < 0 ? box.right : box.left, box.y)
      await settle()
      await js(`document.querySelector('.sb-tabstrip').scrollLeft=${direction < 0 ? '1e9' : '0'}`)
      await settle()
      held = await geometry(0)
      if (direction > 0 || step === 0 || (held.limit - held.scroll > 0.01 && held.limit - held.scroll < 1)) break
    }
    assert(await js("document.body.classList.contains('sb-dragging-tab')"), 'real pointer drag started')
    if (step && direction < 0) assert(held.limit - held.scroll > 0.01 && held.limit - held.scroll < 1,
      'fractional endpoint fixture must actually fall below its rounded limit')
    await pause(1600)
    held = await geometry(0)
    await mouse('mouseMoved', direction < 0 ? held.left : held.right, held.y)
    // A caret moving away from the final tab can shrink overflow by a few pixels. Require 20px
    // so that layout-only adjustment cannot stand in for resumed reverse scrolling.
    const motion = await js(`new Promise(resolve=>{
      const el=document.querySelector('.sb-tabstrip'), before=${held.scroll}, start=performance.now();
      function sample(){const ms=performance.now()-start, progress=(el.scrollLeft-before)*${direction};
        if(progress>=20||ms>250) resolve({ms,progress}); else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`)
    await mouse('mouseReleased', direction < 0 ? held.left : held.right, held.y)
    const result = { theme, step, direction, held, ...motion }
    results.push(result)
    if (motion.progress < 20 || motion.ms > 250) failures.push(`drag reversal ${theme}/+${step}/${direction}: ${JSON.stringify(motion)}`)
  }
  // Keep the source hook active while the target becomes a different real strip.
  win.webContents.setZoomLevel(0.5)
  await js("window.configure({count:16,layout:'scroll',activeIndex:0,secondary:true})")
  await settle()
  const source = await geometry(0), target = await geometry(1)
  await js("document.querySelectorAll('.sb-tabstrip').forEach(el=>{el.scrollLeft=500})")
  await settle()
  const press = await js(`(() => {
    const strip=document.querySelector('.sb-tabstrip'), box=strip.getBoundingClientRect();
    const tab=[...strip.querySelectorAll('.sb-tab')].find(el=>{const r=el.getBoundingClientRect();return r.left>box.left+30&&r.right<box.right-30});
    const r=tab.getBoundingClientRect();return {x:r.left+15,y:r.top+r.height/2};
  })()`)
  await mouse('mouseMoved', press.x, press.y)
  await mouse('mousePressed', press.x, press.y)
  await mouse('mouseMoved', source.right, source.y)
  await pause(80)
  await mouse('mouseMoved', target.right, target.y)
  await settle()
  const sourceBefore = (await geometry(0)).scroll, targetBefore = (await geometry(1)).scroll
  await pause(100)
  const sourceAfter = (await geometry(0)).scroll, targetAfter = (await geometry(1)).scroll
  if (sourceAfter !== sourceBefore || targetAfter <= targetBefore + 20) failures.push('drag strip transition did not transfer scrolling to the target')
  await mouse('mouseReleased', target.right, target.y)
  await js('window.configure({secondary:false})')
  await settle()
  return { results, failures, transition: { sourceBefore, sourceAfter, targetBefore, targetAfter } }
}
