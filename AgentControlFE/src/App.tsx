import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import ConversationChat from './pages/ConversationChat'
import Home, { AgentRedirect, SettingsRedirect } from './pages/Home'

/**
 * FE-1 routes: chat only. `/c/:id` is the app; `/` picks a chat. The retired
 * pages (/agents*, /projects*, /skills, /notes) redirect home; `/agents/:id`
 * goes to that bot's DM.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="c/:conversationId" element={<ConversationChat />} />
        <Route path="agents/new" element={<Navigate to="/" replace />} />
        <Route path="agents/:id" element={<AgentRedirect />} />
        <Route path="settings" element={<SettingsRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
