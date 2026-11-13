import type { Root } from 'react-dom/client'
import type { ScrumPokerAppProps } from './App'
import './styles.css'

export function bootstrapIssuePanel(_container: HTMLElement, _props?: ScrumPokerAppProps): Root {
  throw new Error('not implemented')
}

if (typeof document !== 'undefined') {
  const rootElement = document.getElementById('root')
  if (rootElement instanceof HTMLElement) {
    bootstrapIssuePanel(rootElement)
  }
}
