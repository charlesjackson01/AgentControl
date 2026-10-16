import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import AgentFormPage from './pages/AgentFormPage'
import AgentChat from './pages/AgentChat'
import Agents from './pages/Agents'
import ProjectChat from './pages/ProjectChat'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import SkillLibrary from './pages/SkillLibrary'
import Notes from './pages/Notes'
import ConversationChat from './pages/ConversationChat'
import Landing from './pages/Landing'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Landing />} />
        <Route path="c/:conversationId" element={<ConversationChat />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/new" element={<AgentFormPage />} />
        <Route path="agents/:id" element={<AgentChat />} />
        <Route path="agents/:id/edit" element={<AgentFormPage />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectChat />} />
        <Route path="skills" element={<SkillLibrary />} />
        <Route path="notes" element={<Notes />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
