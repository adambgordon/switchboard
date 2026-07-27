import type { TranscriptBlock, TranscriptMessage } from './types'

function hasVisibleContent(blocks: readonly TranscriptBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === 'image' || (block.kind === 'text' && block.text.trim().length > 0)
  )
}

/** A user-facing message: visible prose/image content authored by the human or agent. */
export function isConversationalMessage(
  message: Pick<TranscriptMessage, 'role' | 'userKind' | 'blocks'>
): boolean {
  const conversationalAuthor = message.role === 'assistant' || message.userKind === 'human'
  return conversationalAuthor && hasVisibleContent(message.blocks)
}

export function countConversationalMessages(messages: readonly TranscriptMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (isConversationalMessage(message)) count += 1
  }
  return count
}
