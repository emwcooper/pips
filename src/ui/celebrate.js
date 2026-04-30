// Personal-best celebration: pops a centered card with a cute animal +
// confetti emojis radiating outward. Auto-dismisses after a few seconds;
// clicking the overlay dismisses it early.

const ANIMALS = ['🐶','🐱','🐰','🦊','🐼','🐯','🐨','🐸','🐵','🦁','🐹','🐻','🐧','🐢','🐙','🦄'];
const SPARKLES = ['✨','🎉','⭐','💫','🌟','🎊','🩷','💖'];

export function showCelebration(text) {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];

  const overlay = document.createElement('div');
  overlay.className = 'celebrate';

  const card = document.createElement('div');
  card.className = 'celebrate-card';
  const a = document.createElement('span');
  a.className = 'celebrate-animal';
  a.textContent = animal;
  card.appendChild(a);
  const t = document.createElement('div');
  t.className = 'celebrate-text';
  t.textContent = text;
  card.appendChild(t);
  overlay.appendChild(card);

  // Particle burst — radiate from the screen center.
  const N = 28;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('span');
    p.className = 'celebrate-particle';
    p.textContent = SPARKLES[Math.floor(Math.random() * SPARKLES.length)];
    const angle = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const dist = 200 + Math.random() * 180;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.animationDelay = `${Math.random() * 220}ms`;
    p.style.fontSize = `${22 + Math.random() * 14}px`;
    overlay.appendChild(p);
  }

  document.body.appendChild(overlay);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    overlay.classList.add('celebrate-fading');
    setTimeout(() => overlay.remove(), 400);
  };
  overlay.addEventListener('click', dismiss);
  setTimeout(dismiss, 3200);
}
