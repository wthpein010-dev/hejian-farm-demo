/* Shared original SVG primitives for the H5 demo. */
(()=>{
  const paths = {
    sprout:'M12 21v-9M12 16C4 16 3 9 3 9s8-2 9 7Zm0-5C12 4 21 3 21 3s1 8-9 8Z',
    farm:'m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7M2 21h20',
    seed:'M20 4C6 2 2 12 7 17c5 5 15 1 13-13ZM5 20 16 9M10 15v-5m0 5h5',
    camera:'M8 7 10 4h4l2 3h4v13H4V7h4Zm8 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z',
    user:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
    bell:'M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Zm4 12a2 2 0 0 0 4 0',
    chevron:'m9 5 7 7-7 7', back:'m15 5-7 7 7 7', close:'m6 6 12 12M6 18 18 6',
    sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
    leaf:'M21 3C9 1 2 9 6 16c6 7 17-1 15-13ZM3 21 16 8M10 14V9m0 5h5',
    drop:'M12 2S4 11 4 16a8 8 0 0 0 16 0C20 11 12 2 12 2Zm-4 14a4 4 0 0 0 4 4',
    bag:'M5 7h14l2 14H3L5 7Zm3 0V5a4 4 0 0 1 8 0v2',
    bug:'M8 9a4 4 0 0 1 8 0v7a4 4 0 0 1-8 0V9Zm4 0v11M9 5 7 3m8 2 2-2M4 10h4m8 0h4M3 15h5m8 0h5M5 21l3-3m8 0 3 3',
    pin:'M19 9c0 6-7 13-7 13S5 15 5 9a7 7 0 0 1 14 0Zm-4 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
    clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-6v6l4 2',
    check:'m5 12 5 5L20 7', checkCircle:'M21 12a9 9 0 1 1-4-7M8 11l4 4L22 5',
    wifi:'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01',
    power:'M12 2v10M6 5a9 9 0 1 0 12 0',
    shield:'m12 2 8 4v6c0 6-8 10-8 10S4 18 4 12V6l8-4Zm-4 10 3 3 5-6',
    box:'m3 7 9-5 9 5v11l-9 5-9-5V7Zm0 0 9 5 9-5M12 12v11M7 4l10 5',
    truck:'M1 4h13v13H1V4Zm13 5h5l4 5v3h-9V9ZM8 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-6h4l1 3 3 1 3 1v4l-2 2 1 3-3 3-3-1-2 3H8l-1-3-3-1-2-3 2-3-1-3 3-3 3 1 1-3Z',
    help:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12-3a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01',
    play:'m9 5 11 7-11 7V5Z', refresh:'M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 2m0 8a9 9 0 0 0 16-2',
    list:'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
    arrow:'M3 12h18m-6-6 6 6-6 6', heart:'M20 5c-3-3-7-1-8 2-1-3-5-5-8-2-6 6 8 15 8 15S26 11 20 5Z',
    basket:'m4 8 3 12h10l3-12H4Zm4 0 4-6 4 6M9 12v4m6-4v4M2 8h20',
    signal:'M4 19v-3m5 3v-7m6 7V8m5 11V3',
  };
  function icon(name, cls='') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.leaf}"/></svg>`; }
  function cropArt(type) {
    const arts = {
      tomato:'<ellipse cx="31" cy="47" rx="20" ry="5" fill="#6a683b12"/><path d="M31 17c-20-8-29 18-15 28 9 7 29 4 32-8 3-12-7-23-17-20Z" fill="#df654b"/><path d="M31 19c-10 4-12 22-5 27-14-3-19-16-10-25 5-4 9-5 15-2Z" fill="#ef8265"/><path d="m31 20-11 1 7-6-2-7 8 6 9-4-4 8 7 5-11-1-4 9Z" fill="#4e7943"/><path d="m32 18 1-12" stroke="#496f3a" stroke-width="3" stroke-linecap="round"/><path d="M18 29c-2 3-2 6-1 8" stroke="#f4a187" stroke-width="3" stroke-linecap="round"/>',
      carrot:'<path d="m25 21 14 8-23 25c-2 2-5 1-4-2l10-30Z" fill="#e78c36"/><path d="m24 24 6 4-17 24Z" fill="#f4ac53"/><path d="m27 23-4-14q8-2 9 11L38 5q8 6-3 19l14-9q3 10-12 12Z" fill="#6f964f"/><path d="m23 33 5 3m-9 3 4 2m-9 3 4 2" stroke="#c97127" stroke-width="2" stroke-linecap="round"/>',
      lettuce:'<path d="M32 52C7 53 5 34 13 29c-7-13 3-22 13-16 6-12 21-8 20 3 13-1 16 13 7 19 5 13-8 20-21 17Z" fill="#92b564"/><path d="M32 49C16 45 12 31 21 26c-5-10 4-16 11-8 7-12 18-1 12 8 12 6 6 18-12 23Z" fill="#b0cd7c"/><path d="m31 51 3-29m-2 22-11-9m12 2 10-7m-10 2-6-5" fill="none" stroke="#6c964d" stroke-width="2" stroke-linecap="round"/>',
      radish:'<path d="M22 25c7-8 20-6 22 5 3 13-9 21-14 27-1-8-17-17-8-32Z" fill="#d97781"/><path d="M30 42c-5 4-3 9 0 15 6-7 10-9 12-16Z" fill="#f5e7d8"/><path d="m30 26-7-17c6-4 11 4 11 13l6-18c9 3 1 16-4 22l14-11c7 9-8 13-14 15Z" fill="#779f58"/><path d="m24 31 5-2" stroke="#e99ba0" stroke-width="3" stroke-linecap="round"/>',
      onion:'<path d="m23 48 4-32m3 32L39 7m-5 44 17-28M20 47 17 8m9 39L33 6" stroke="#6e9b4e" stroke-width="5" stroke-linecap="round"/><path d="m20 43 1 11m6-11-2 12m8-11-3 12" stroke="#e6dfbc" stroke-width="5" stroke-linecap="round"/><path d="m21 54-3 6m7-5 1 5m4-6 4 4" stroke="#ae9a69" stroke-width="1.4" stroke-linecap="round"/>',
      chicken:'<path d="M20 21c-2-9 9-14 14-7 6-4 13 1 11 8 12 17 3 31-13 31-17 0-23-11-18-22l-5-9 11 4Z" fill="#fff6d8"/><path d="M29 15c-6-9 3-15 6-8 7-6 12 3 5 9" fill="#cd6d52"/><path d="m44 23 9 4-10 4" fill="#d9a64f"/><circle cx="39" cy="22" r="2" fill="#434a33"/><path d="M18 33c-3 9 9 15 17 7" fill="#e9d4a4"/><path d="m26 52-2 7m12-7 2 7m-16 0h7m6 0h7" stroke="#b28d4a" stroke-width="2" stroke-linecap="round"/>',
      egg:'<path d="M17 37C17 24 26 8 32 8s15 16 15 29c0 18-30 18-30 0Z" fill="#e7cfa2"/><path d="M24 26c-5 7-6 15 0 19" fill="none" stroke="#f8ebce" stroke-width="5" stroke-linecap="round"/>',
      empty:'<path d="m10 37 22-12 22 12-22 13Z" fill="#c6b18b"/><path d="m10 37 22 13v6L10 43Zm22 13 22-13v6L32 56Z" fill="#a28c64"/><path d="M32 37V20m0 9c-10 0-12-10-12-10s12-2 12 10Zm0-8c0-10 12-11 12-11s1 11-12 11Z" fill="#719650" stroke="#719650" stroke-width="1.6"/>',
    };
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${arts[type] || arts.lettuce}</svg>`;
  }

  paths.gift='M3 8h18v4H3V8Zm2 4v9h14v-9M12 8v13M12 8c-10 0-7-9-3-6l3 6Zm0 0c10 0 7-9 3-6l-3 6Z';
  paths.pig='M5 10C0 4 6 3 9 7c9-4 13 2 13 8 0 4-3 6-7 6H8l-1-4-4-2v-4l2-1ZM17 10h.01M10 21v-3m8 3v-3M4 10H1';
  paths.video='M3 5h13v14H3V5Zm13 5 6-4v12l-6-4v-4Z';
  paths.share='M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm2-5 7-4m-7 8 7 4';
  paths.minus='M5 12h14';
  function animalArt(type) {
    if(type==='chicken')return cropArt('chicken');
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="33" cy="56" rx="23" ry="4" fill="#243c2912"/><path d="M13 29c-7-14 5-18 12-7 21-8 34 4 31 20-1 8-7 12-17 12H23c-9-1-16-9-15-17l5-8Z" fill="${type==='goat'?'#d6cfb9':'#bd9587'}"/><path d="m13 30-8 4v12l12 2 5-11Z" fill="${type==='goat'?'#a29578':'#d3ab9a'}"/><circle cx="24" cy="29" r="2" fill="#303b2b"/><path d="m24 50-1 9m23-9 1 9" stroke="#6a6952" stroke-width="4" stroke-linecap="round"/><path d="M54 28q10-8 6-13" stroke="#a18371" stroke-width="3" fill="none"/>${type==='goat'?'<path d="m17 22-3-16m8 15L27 6" stroke="#7c785d" stroke-width="4" stroke-linecap="round"/>':''}</svg>`;
  }
  window.FarmUI={icon,cropArt,animalArt};

})();
