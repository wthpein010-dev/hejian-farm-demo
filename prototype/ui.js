/* Shared operation icons and photographic AI demonstration assets. */
(()=>{
  const paths = {
    search:'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
    heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
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
  const photoKeys=new Set(['tomato','carrot','lettuce','radish','onion','bokchoy','chicken','egg','empty','pig','goat','feed','fertilizer','tools','seed','sign','frame','bundle','gift']);
  function photoArt(type){
    const key=photoKeys.has(type)?type:'lettuce';
    return `<img class="asset-photo" src="assets/photos/${key}.webp" alt="" width="640" height="640" loading="lazy" decoding="async" draggable="false">`;
  }
  const cropArt=photoArt;

  paths.gift='M3 8h18v4H3V8Zm2 4v9h14v-9M12 8v13M12 8c-10 0-7-9-3-6l3 6Zm0 0c10 0 7-9 3-6l-3 6Z';
  paths.pig='M5 10C0 4 6 3 9 7c9-4 13 2 13 8 0 4-3 6-7 6H8l-1-4-4-2v-4l2-1ZM17 10h.01M10 21v-3m8 3v-3M4 10H1';
  paths.video='M3 5h13v14H3V5Zm13 5 6-4v12l-6-4v-4Z';
  paths.share='M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm2-5 7-4m-7 8 7 4';
  paths.minus='M5 12h14';
  paths.home='m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7';
  paths.arrow='M4 12h16m-6-6 6 6-6 6';
  paths.users='M15 21v-2a6 6 0 0 0-12 0v2M13 4a4 4 0 0 1 0 8M21 21v-2a6 6 0 0 0-4-5M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z';
  paths.chat='M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 1 1 19 0ZM7 10h10M7 14h6';
  paths.message=paths.chat;
  paths.plus='M12 4v16M4 12h16';
  paths.flag='M5 22V3c5-5 9 5 15 0v12c-6 5-10-5-15 0';
  paths.userPlus='M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM2 21v-2a8 8 0 0 1 13-6M19 13v8M15 17h8';
  const animalArt=photoArt;
  window.FarmUI={icon,cropArt,animalArt,photoArt};

})();
