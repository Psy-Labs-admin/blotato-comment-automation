let attempt = 0;

async function exchangeTicket() {
  const currentAttempt = ++attempt;
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  history.replaceState(null, '', '/session/enter');
  const message = document.getElementById('message');
  message.textContent = 'Opening your workspace…';
  try {
    if (!ticket) throw new Error();
    const response = await fetch('/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) throw new Error();
    if (attempt === currentAttempt) location.replace('/console');
  } catch {
    if (attempt === currentAttempt)
      message.textContent = 'This sign-in link has expired. Open a new link or sign in with your access token.';
  }
}

window.addEventListener('hashchange', exchangeTicket);
exchangeTicket();
