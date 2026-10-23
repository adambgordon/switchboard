const assert = require('node:assert/strict')

function pixelsOf(image) {
  const size = image.getSize(), bytes = image.toBitmap()
  assert.equal(bytes.length, size.width * size.height * 4, 'screenshot bitmap scale')
  return { ...size, at(x, y) {
    assert(x >= 0 && y >= 0 && x < size.width && y < size.height, `Pixel outside screenshot: ${x},${y}`)
    const i = (y * size.width + x) * 4
    return [bytes[i + 2], bytes[i + 1], bytes[i]]
  } }
}
// A divider can separate two DIFFERENT surfaces — the active tab is lifted onto the pane's color, and
// the last row's rule has the strip above it and whatever lies below the strip beneath it. Scoring
// every pixel against the strip's color would count the other surface as stroke whenever it sits on
// the rule's side of the strip, so each pixel is scored against the surface on its own side of the
// divider's trailing edge (`split`, in device pixels): the first sample's color before it, the last
// sample's after. A divider between two strip-colored tabs scores exactly as against the strip.
function profile(samples, split, rule) {
  const before = samples[0][1], after = samples[samples.length - 1][1]
  const coverage = samples.map(([position, color]) => {
    const surface = position + 1 > split ? after : before
    return { position, color, coverage: Math.max(0, Math.min(1, (color[0] - surface[0]) / (rule[0] - surface[0]))) }
  })
  return {
    samples: coverage,
    painted: coverage.filter(p => p.coverage > 0.5).map(p => p.position),
    weight: coverage.reduce((total, sample) => total + sample.coverage, 0)
  }
}

module.exports = { pixelsOf, profile }
