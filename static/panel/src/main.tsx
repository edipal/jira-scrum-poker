import { type Root, createRoot } from 'react-dom/client'
import { ScrumPokerApp, type ScrumPokerAppProps, ensureThemeEnabled } from './App'
import { createPokerClient } from './bridge/poker-client'
import './styles.css'

export function bootstrapIssuePanel(container: HTMLElement, props?: ScrumPokerAppProps): Root {
  if (typeof HTMLElement === 'undefined' || !(container instanceof HTMLElement)) {
    throw new TypeError('Issue panel root container must be an HTMLElement')
  }

  const client = props?.client ?? createPokerClient()
  void ensureThemeEnabled(client)

  const root = createRoot(container)
  root.render(<ScrumPokerApp {...props} client={client} />)
  return root
}

if (typeof document !== 'undefined') {
  const rootElement = document.getElementById('root')
  if (rootElement instanceof HTMLElement) {
    const client = createPokerClient()
    void ensureThemeEnabled(client).finally(() => {
      if (rootElement.isConnected) {
        bootstrapIssuePanel(rootElement, { client })
      }
    })
  }
}
