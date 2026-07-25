import { Suspense } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

function InitialScreen() {
  return (
    <div className="init-screen">
      {/* Animated background grid */}
      <div className="init-grid" />

      {/* Floating particles */}
      <div className="init-particles">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="init-particle" style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>

      {/* Main content */}
      <div className="init-content">
        {/* Animated logo mark */}
        <div className="init-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect className="init-logo-rect init-logo-rect-1" x="4" y="4" width="18" height="18" rx="4" />
            <rect className="init-logo-rect init-logo-rect-2" x="26" y="4" width="18" height="18" rx="4" />
            <rect className="init-logo-rect init-logo-rect-3" x="4" y="26" width="18" height="18" rx="4" />
            <rect className="init-logo-rect init-logo-rect-4" x="26" y="26" width="18" height="18" rx="4" />
          </svg>
        </div>

        <h1 className="init-title">Building your project</h1>
        <p className="init-subtitle">AI is writing code — watch it come to life</p>

        {/* Animated progress bar */}
        <div className="init-progress">
          <div className="init-progress-bar" />
        </div>

        {/* Animated status dots */}
        <div className="init-dots">
          <span className="init-dot" style={{ animationDelay: '0s' }} />
          <span className="init-dot" style={{ animationDelay: '0.15s' }} />
          <span className="init-dot" style={{ animationDelay: '0.3s' }} />
        </div>
      </div>
    </div>
  )
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <InitialScreen />,
  },
])

export default function App() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <RouterProvider router={router} />
    </Suspense>
  )
}
