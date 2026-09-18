import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMath } from './mathDelimiters'
import { copyText, type Alignment, type CopyNode } from './mdCopy'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  url?: string
  title?: string | null
  alt?: string
  identifier?: string
  lang?: string | null
  align?: Alignment[]
}
const plain = unified().use(remarkParse).use(remarkGfm)
const mathDouble = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false })
const mathSingle = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: true })

/** Whole exports can include unmounted messages, so their adapter reads the same Markdown dialect. */
export function markdownCopyNodes(source: string): CopyNode[] {
  const math = normalizeMath(source)
  const parser = !math.hasMath ? plain : math.singleDollar ? mathSingle : mathDouble
  const tree = parser.parse(math.text) as MdNode
  const definitions = new Map<string, MdNode>()
  const footnotes = new Map<string, MdNode>()
  const referenced: string[] = []
  const referenceIndices = new Map<string, number>()
  const findDefinitions = (node: MdNode): void => {
    if (node.type === 'definition') definitions.set(node.identifier ?? '', node)
    if (node.type === 'footnoteDefinition') footnotes.set(node.identifier ?? '', node)
    node.children?.forEach(findDefinitions)
  }
  findDefinitions(tree)
  const convertChildren = (node: MdNode): CopyNode[] => (node.children ?? []).flatMap(convert)
  const convert = (node: MdNode): CopyNode[] => {
    switch (node.type) {
      case 'definition': case 'footnoteDefinition': return []
      case 'text': case 'html': return [copyText(node.value ?? '')]
      case 'paragraph': return [{ kind: 'paragraph', children: convertChildren(node) }]
      case 'heading': return [{ kind: 'heading', level: node.depth ?? 1, children: convertChildren(node) }]
      case 'strong': case 'emphasis': case 'delete': return [{
        kind: node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' : 'strike', children: convertChildren(node)
      }]
      case 'blockquote': return [{ kind: 'quote', children: convertChildren(node) }]
      case 'list': return [{ kind: 'list', start: node.ordered ? node.start ?? 1 : null, children: convertChildren(node) }]
      case 'listItem': return [{ kind: 'item', checked: node.checked ?? undefined, children: convertChildren(node) }]
      case 'code': case 'inlineCode': return [{ kind: 'code', block: node.type === 'code', value: node.value ?? '', lang: node.lang ?? undefined }]
      case 'math': case 'inlineMath': return [{ kind: 'math', display: node.type === 'math', value: node.value ?? '' }]
      case 'link': case 'linkReference': {
        const destination = node.type === 'linkReference' ? definitions.get(node.identifier ?? '') : node
        return [{ kind: 'link', url: destination?.url ?? '', title: destination?.title ?? undefined, children: convertChildren(node) }]
      }
      case 'image': case 'imageReference': {
        const destination = node.type === 'imageReference' ? definitions.get(node.identifier ?? '') : node
        return [{ kind: 'image', value: node.alt?.trim() ? node.alt : 'image', url: destination?.url, title: destination?.title ?? undefined }]
      }
      case 'table': return [{ kind: 'table', align: node.align ?? [], children: convertChildren(node) }]
      case 'tableRow': return [{ kind: 'row', children: convertChildren(node) }]
      case 'tableCell': return [{ kind: 'cell', children: convertChildren(node) }]
      case 'break': return [{ kind: 'break' }]
      case 'thematicBreak': return [{ kind: 'rule' }]
      case 'footnoteReference': {
        const id = node.identifier ?? ''
        if (!referenceIndices.has(id)) {
          referenced.push(id)
          referenceIndices.set(id, referenced.length)
        }
        return [copyText(String(referenceIndices.get(id)))]
      }
      default: return convertChildren(node)
    }
  }
  const nodes = convertChildren(tree)
  const notes: CopyNode[] = []
  for (const id of referenced) {
    const definition = footnotes.get(id)
    if (definition) notes.push({ kind: 'item', children: convertChildren(definition) })
  }
  if (notes.length) nodes.push({ kind: 'list', start: 1, children: notes })
  return nodes
}
