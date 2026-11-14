import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import { LoginPage, SignupPage } from './pages/Auth';
import { AnalyticsPage, AutomationsPage, KnowledgePage, SettingsPage } from './pages/Placeholders';
import Inbox from './pages/Inbox';
import Tickets, { TicketDetailPage } from './pages/Tickets';
import Customers, { CustomerDetailPage } from './pages/Customers';
import Team from './pages/Team';
import WidgetDemo from './pages/WidgetDemo';
import WidgetEmbed from './pages/WidgetEmbed';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      {/* Public embeddable widget — no auth, no Layout. */}
      <Route path="/widget-embed" element={<WidgetEmbed />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:conversationId" element={<Inbox />} />
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
          <Route path="/team" element={<Team />} />
          <Route path="/widget-demo" element={<WidgetDemo />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<LoginPage />} />
    </Routes>
  );
}
