import { type Root, createRoot } from 'react-dom/client'
import { ScrumPokerApp, type ScrumPokerAppProps } from './App'
import './styles.css'

export function bootstrapIssuePanel(container: HTMLElement, props?: ScrumPokerAppProps): Root {
  if (typeof HTMLElement === 'undefined' || !(container instanceof HTMLElement)) {
    throw new TypeError('Issue panel root container must be an HTMLElement')
  }

  const root = createRoot(container)
  root.render(<ScrumPokerApp {...props} />)
  return root
}

if (typeof document !== 'undefined') {
  const rootElement = document.getElementById('root')
  if (rootElement instanceof HTMLElement) {
    bootstrapIssuePanel(rootElement)
  }
}
