import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import AgentFormPage from './pages/AgentFormPage'
import AgentChat from './pages/AgentChat'
import Agents from './pages/Agents'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import SkillLibrary from './pages/SkillLibrary'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/new" element={<AgentFormPage />} />
        <Route path="agents/:id" element={<AgentChat />} />
        <Route path="agents/:id/edit" element={<AgentFormPage />} />
        <Route path="projects" element={<Projects />} />
        <Route path="skills" element={<SkillLibrary />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  )
}
