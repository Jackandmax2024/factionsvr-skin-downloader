# factionsvr-skin-downloader

paste the following into a bookmarklet or dev tools ctrl + shift + J and heres the script: javascript:(function(){fetch('https://raw.githubusercontent.com/Jackandmax2024/factionsvr-skin-downloader/refs/heads/main/factionsvr-menu.js').then(r=>r.text()).then(t=>{var s=document.createElement('script');s.text=t;document.body.appendChild(s);}).catch(e=>console.error(e));})();
