/* ================================================================
   CONFIG / GLOBAL STATE
   ================================================================ */

// Riot's public, no-auth-required static data API. Serves champion
// data and images as plain JSON/PNGs, versioned by game patch.
const DDRAGON = 'https://ddragon.leagueoflegends.com';

let VERSION = null;          // current patch version string, e.g. "14.14.1"
let CHAMPIONS = {};          // full champion list, keyed by champion id (e.g. "Ahri")
let CURRENT_CHAMPION = null; // id of the champion currently displayed
let HASTE = 0;               // the ability haste value the user has entered

// Cache references to the DOM elements we update repeatedly
const champSelectEl = document.getElementById('champSelect');
const mainEl = document.getElementById('main');
const splashBg1El = document.getElementById('splashBg1');
const splashBg2El = document.getElementById('splashBg2');

let splashInterval = null; // handle for the auto-advance timer, so it can be cleared when switching champions
let splashActiveLayer = 1; // which of the two crossfade layers is currently visible (1 or 2)

/* ================================================================
   THE CORE FORMULA
   This is Riot's actual Ability Haste formula (used since the CDR
   rework): every point of haste gives a diminishing-returns
   reduction, converging toward 0 seconds but never reaching it.
   ================================================================ */
function effectiveCD(base, haste){
  return base / (1 + haste/100);
}

/* Formats a cooldown number to 1 decimal place, but drops the decimal
   entirely when it rounds to a whole number (e.g. 8.0 -> "8", but 8.1
   stays "8.1"). Keeps the display clean without losing precision. */
function formatCD(value){
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/* ================================================================
   STARTUP: fetch the latest patch version, then the full champion
   list (names/titles/portraits only - not full ability data yet).
   ================================================================ */
async function init(){
  try{
    // versions.json is an array of every patch version, newest first
    const versions = await fetch(`${DDRAGON}/api/versions.json`).then(r=>r.json());
    VERSION = versions[0];

    // champion.json (summary list) has every champion's id/name/title/icon
    const data = await fetch(`${DDRAGON}/cdn/${VERSION}/data/en_US/champion.json`).then(r=>r.json());
    CHAMPIONS = data.data;

    populateChampSelect();
  }catch(err){
    champSelectEl.innerHTML = `<option value="">Couldn't load champion data</option>`;
  }
}

/* Fills the dropdown with one <option> per champion, alphabetically
   sorted. The browser's native select already supports "jump to
   option by typing", so no separate search box is needed. */
function populateChampSelect(){
  const sorted = Object.values(CHAMPIONS).sort((a,b)=>a.name.localeCompare(b.name));
  champSelectEl.innerHTML = `<option value="">Select a champion...</option>` +
    sorted.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
}

// Fetch and render the champion whenever the dropdown selection changes
champSelectEl.addEventListener('change', ()=>{
  if(champSelectEl.value) selectChampion(champSelectEl.value);
});

/* ================================================================
   Called when a champion is clicked. The summary data from
   champion.json doesn't include ability cooldowns, so we fetch
   that champion's own detail file, which does.
   ================================================================ */
async function selectChampion(id){
  CURRENT_CHAMPION = id;

  mainEl.innerHTML = `<div class="loading">Loading abilities...</div>`;
  try{
    // champion/{id}.json contains full spell data, including the cooldown array
    const full = await fetch(`${DDRAGON}/cdn/${VERSION}/data/en_US/champion/${id}.json`).then(r=>r.json());
    const champ = full.data[id];
    renderChampion(champ);
  }catch(err){
    mainEl.innerHTML = `<div class="error-box">Couldn't load ability data for this champion.</div>`;
  }
}

/* ================================================================
   Draws the circular "haste dial" SVG: a ring that fills up based
   on the derived CDR%, with that same CDR% shown as the number in
   the center (the raw haste value is already visible in the input
   field next to this, so showing it twice would be redundant).
   CDR% = haste / (100 + haste) * 100 - this is the "% cooldown
   reduction" that a given haste value is mathematically equivalent to.
   ================================================================ */
function drawHasteDial(haste){
  const cdrPct = (haste/(100+haste))*100;
  const radius = 42;
  const circumference = 2*Math.PI*radius;
  const clampedPct = Math.min(cdrPct, 100); // ring can't visually exceed a full circle
  const dash = circumference * (clampedPct/100);
  return `
    <svg width="112" height="112" viewBox="0 0 112 112">
      <circle cx="56" cy="56" r="${radius}" fill="none" stroke="#1a2430" stroke-width="8"/>
      <circle cx="56" cy="56" r="${radius}" fill="none" stroke="#0ac8b9" stroke-width="8"
        stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"
        transform="rotate(-90 56 56)"/>
      <text x="56" y="52" text-anchor="middle" fill="#f0d9a3" font-family="JetBrains Mono, monospace" font-size="22" font-weight="700">${Math.round(cdrPct)}%</text>
      <text x="56" y="68" text-anchor="middle" fill="#7d8aa0" font-family="Inter, sans-serif" font-size="9" letter-spacing="0.5">CDR</text>
    </svg>`;
}

/* Not every entry in a champion's skins array has its own splash art -
   some entries are chroma variants of a base skin and carry a
   "parentSkin" field pointing back to it. Those have no splash image
   of their own (loading one gives a blank/broken image), so they're
   filtered out here before the cycle is built. */
function realSkins(champ){
  return champ.skins.filter(s => s.parentSkin === undefined);
}

// Tracks whichever champion/skin is currently shown as the background,
// so a resize/orientation change can redraw it in the other format
// without waiting for the next auto-advance.
let currentSplashChampId = null;
let currentSplashSkinNum = null;

/* Data Dragon serves two crops of each skin's art: the wide "splash"
   used in the client's collection screen, and a taller "loading"
   crop (already portrait-oriented) used on the loading screen. Below
   a width breakpoint - matching the same one the rest of the layout
   uses to switch to its mobile view - we use the loading crop, since
   it suits narrow/portrait screens far better than a cropped wide image. */
function isNarrowViewport(){
  return window.matchMedia('(max-width: 760px)').matches;
}
function buildSplashUrl(champId, skinNum){
  const folder = isNarrowViewport() ? 'loading' : 'splash';
  return `${DDRAGON}/cdn/img/champion/${folder}/${champId}_${skinNum}.jpg`;
}

/* Crossfades the full-page background to a new splash art image.
   Two stacked layers are used because a single element can't smoothly
   animate a change to its own background-image with CSS alone: this
   preloads the image into the currently-hidden layer, then flips
   opacity on both layers at once so the swap fades in/out together. */
function crossfadeSplash(champId, skinNum){
  currentSplashChampId = champId;
  currentSplashSkinNum = skinNum;

  const showEl = splashActiveLayer === 1 ? splashBg2El : splashBg1El;
  const hideEl = splashActiveLayer === 1 ? splashBg1El : splashBg2El;

  const url = buildSplashUrl(champId, skinNum);
  const preload = new Image();
  preload.onload = () => {
    showEl.style.backgroundImage = `url('${url}')`;
    showEl.style.opacity = '1';
    hideEl.style.opacity = '0';
    splashActiveLayer = splashActiveLayer === 1 ? 2 : 1;
  };
  preload.src = url;
}

// If the viewport crosses the narrow/wide breakpoint (e.g. rotating a
// phone, or resizing a browser window), redraw whatever skin is
// currently showing using the appropriate crop instead of waiting for
// the next scheduled skin change.
let lastViewportWasNarrow = isNarrowViewport();
window.addEventListener('resize', ()=>{
  const nowNarrow = isNarrowViewport();
  if(nowNarrow !== lastViewportWasNarrow){
    lastViewportWasNarrow = nowNarrow;
    if(currentSplashChampId !== null){
      crossfadeSplash(currentSplashChampId, currentSplashSkinNum);
    }
  }
});

/* Starts automatically cycling through a champion's splash art:
   crossfades to the default skin immediately, then advances to the
   next skin (looping back to the start) on a slow timer. Clears any
   previous champion's timer first, since only one should run at a
   time. */
function startSplashCycle(champ){
  if(splashInterval) clearInterval(splashInterval);

  const skins = realSkins(champ);
  let index = 0;

  function showIndex(i){
    index = i;
    crossfadeSplash(champ.id, skins[index].num);
  }

  showIndex(0); // start on the default skin

  if(skins.length > 1){
    splashInterval = setInterval(()=>{
      showIndex((index + 1) % skins.length);
    }, 6000); // 6s per skin; the actual fade duration is set by the CSS transition
  }
}

/* Builds one <tr> showing, for every rank, the base cooldown stacked
   above the haste-adjusted cooldown - each on its own line, so long
   labels/values never wrap awkwardly across a narrow column. */
function cdRow(values, haste){
  const cells = values.map(v=>{
    const eff = effectiveCD(v, haste);
    return `<td><div class="cd-cell"><span class="base-val">${v}s</span><span class="eff-val">${formatCD(eff)}s</span></div></td>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}

/* Builds one full ability card (icon, name, cooldown table or "no
   cooldown" note). Used for the Passive and for each of Q/W/E/R. */
function renderAbilityCard(spellData, keyLabel, isPassive){
  const iconBase = isPassive
    ? `${DDRAGON}/cdn/${VERSION}/img/passive/${spellData.image.full}`
    : `${DDRAGON}/cdn/${VERSION}/img/spell/${spellData.image.full}`;

  let bodyHtml = '';
  const cooldowns = spellData.cooldown;
  // Some abilities (most passives, some on-hit effects) have no numeric cooldown in Riot's data
  if(!cooldowns || cooldowns.length===0 || cooldowns.every(v=>v===0)){
    bodyHtml = `<div class="no-cd">No cooldown (passive or on-hit effect)</div>`;
  }else{
    const rankHeaders = cooldowns.map((_,i)=>`<th>Rk ${i+1}</th>`).join('');
    bodyHtml = `
      <table class="cd-table">
        <tr>${rankHeaders}</tr>
        ${cdRow(cooldowns, HASTE)}
      </table>`;
  }

  return `
    <div class="ability-card ${isPassive?'passive':''}">
      <div class="ability-key">${keyLabel}</div>
      <div class="ability-top">
        <img src="${iconBase}" alt="${spellData.name}">
        <div class="ability-name">${spellData.name}</div>
      </div>
      ${bodyHtml}
    </div>`;
}

/* ================================================================
   Renders the entire right-hand panel for a selected champion:
   header, haste controls, and the grid of ability cards. Also wires
   up the slider/number input/chip buttons so changing haste updates
   every card's numbers live, without re-fetching anything.
   ================================================================ */
function renderChampion(champ){
  const keys = ['Q','W','E','R'];
  const spellCards = champ.spells.map((s,i)=>renderAbilityCard(s, keys[i], false)).join('');
  const passiveCard = renderAbilityCard({
    name: champ.passive.name,
    image: champ.passive.image,
    cooldown: [] // passives never carry cooldown data in Data Dragon
  }, 'P', true);

  mainEl.innerHTML = `
    <div class="champ-header">
      <img src="${DDRAGON}/cdn/${VERSION}/img/champion/${champ.image.full}" alt="${champ.name}">
      <div>
        <h1>${champ.name}</h1>
        <div class="subtitle">${champ.title}</div>
      </div>
    </div>

    <div class="haste-panel">
      <div class="haste-dial" id="hasteDial">${drawHasteDial(HASTE)}</div>
      <div class="haste-controls">
        <label>Ability haste</label>
        <div class="haste-input-row">
          <input type="range" id="hasteSlider" min="0" max="1000" step="1" value="${HASTE}">
          <input type="number" id="hasteNumber" min="0" max="1000" value="${HASTE}">
        </div>
        <div class="haste-chips">
          ${[0,20,40,60,80,100,150].map(v=>`<button data-haste="${v}">${v}</button>`).join('')}
          <span class="haste-chips-divider"></span>
          ${[-10,-5,5,10].map(v=>`<button class="haste-chip-delta${v<0?' haste-chip-delta-neg':''}" data-delta="${v}">${v>0?'+':''}${v}</button>`).join('')}
        </div>
      </div>
    </div>

    <div class="abilities-grid">
      ${passiveCard}
      ${spellCards}
    </div>
  `;

  startSplashCycle(champ);

  const slider = document.getElementById('hasteSlider');
  const number = document.getElementById('hasteNumber');

  // Central handler: whenever haste changes (from slider, number box,
  // or a quick-pick chip), update the global HASTE value and refresh
  // the dial + every cooldown table in place (no re-fetch needed).
  function updateHaste(val){
    HASTE = Math.max(0, Math.min(1000, val));
    slider.value = HASTE;
    number.value = HASTE;
    document.getElementById('hasteDial').innerHTML = drawHasteDial(HASTE);
    document.querySelectorAll('.cd-table').forEach((table, idx)=>{
      const spell = champ.spells[idx];
      if(!spell) return;
      const row = table.querySelector('tr:last-child');
      row.innerHTML = cdRow(spell.cooldown, HASTE).replace(/<\/?tr>/g,'');
    });
  }

  slider.addEventListener('input', ()=>updateHaste(parseInt(slider.value||'0',10)));
  number.addEventListener('input', ()=>updateHaste(parseInt(number.value||'0',10)));
  document.querySelectorAll('.haste-chips button[data-haste]').forEach(btn=>{
    btn.addEventListener('click', ()=>updateHaste(parseInt(btn.dataset.haste,10)));
  });
  // +5 / +10 buttons add to the current value rather than setting it outright
  document.querySelectorAll('.haste-chips button[data-delta]').forEach(btn=>{
    btn.addEventListener('click', ()=>updateHaste(HASTE + parseInt(btn.dataset.delta,10)));
  });
}

// Kick everything off
init();