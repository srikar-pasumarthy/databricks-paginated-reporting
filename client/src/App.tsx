import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import { FileText } from 'lucide-react';
import { ReportsListPage } from './pages/ReportsListPage';
import { ReportBuilderPage } from './pages/ReportBuilderPage';

function Layout() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3">
        <NavLink to="/" className="flex items-center gap-2 text-foreground">
          <FileText className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold">Paginated Reports</span>
        </NavLink>
      </header>
      <main className="flex-1 p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ReportsListPage /> },
      { path: '/reports/:reportId', element: <ReportBuilderPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
