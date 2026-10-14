export const audioMonitorScript = `
(function() {
  // skip duplicate injections
  if (window.__soundCloudMonitorActive) return;
  window.__soundCloudMonitorActive = true;
  
  console.debug('monitor script injected');
  
  // playback state
  let isCurrentlyPlaying = false;
  let currentTrackTitle = '';
  let currentTrackAuthor = '';
  let currentTrackUrl = '';
  let currentTrackElapsed = '';
  let currentTrackDuration = '';
  let isCurrentTrackLiked = false;
  let elapsedObserver = null;
  
  function getTrackInfo() {
    const playButton = document.querySelector('.playControls__play');
    const isPlaying = playButton ? playButton.classList.contains('playing') : false;
    
    const authorEl = document.querySelector('.playbackSoundBadge__lightLink');
    const artworkEl = document.querySelector('.playbackSoundBadge__avatar .image__lightOutline span');
    const elapsedEl = document.querySelector('.playbackTimeline__timePassed span:last-child');
    const durationEl = document.querySelector('.playbackTimeline__duration span:last-child');
    const urlEl = document.querySelector('.playbackSoundBadge__titleLink');
    const likeButtonEl = document.querySelector('.playbackSoundBadge__like');
    
    return {
      title: artworkEl ? artworkEl.getAttribute('aria-label') : '',
      author: authorEl ? authorEl.textContent.trim() : '',
      artwork: artworkEl ? artworkEl.style.backgroundImage.replace(/^url\\(['"]?|['"]?\\)$/g, '') : '',
      elapsed: elapsedEl ? elapsedEl.textContent.trim() : '',
      duration: durationEl ? durationEl.textContent.trim() : '',
      isPlaying: isPlaying,
      isLiked: likeButtonEl ? likeButtonEl.classList.contains('sc-button-selected') : false,
      url: urlEl ? urlEl.href.split('?')[0] : ''
    };
  }

  function notifyPlaybackStateChange() {
    const trackInfo = getTrackInfo();
    const stateChanged = trackInfo.isPlaying !== isCurrentlyPlaying;
    const trackChanged = 
      trackInfo.title !== currentTrackTitle || 
      trackInfo.author !== currentTrackAuthor ||
      trackInfo.url !== currentTrackUrl;
    const elapsedChanged = trackInfo.elapsed !== currentTrackElapsed;
    const durationChanged = trackInfo.duration !== currentTrackDuration;
    const likeChanged = trackInfo.isLiked !== isCurrentTrackLiked;
    
    if (stateChanged || trackChanged || elapsedChanged || likeChanged || !window.__initialStateSent) {
      isCurrentlyPlaying = trackInfo.isPlaying;
      currentTrackTitle = trackInfo.title;
      currentTrackAuthor = trackInfo.author;
      currentTrackUrl = trackInfo.url;
      currentTrackElapsed = trackInfo.elapsed;
      currentTrackDuration = trackInfo.duration;
      isCurrentTrackLiked = trackInfo.isLiked;
      window.__initialStateSent = true;
      
      window.soundcloudAPI.sendTrackUpdate(trackInfo, 'playback-state-change');
      console.debug('Playbook state change:', trackInfo.isPlaying ? 'playing' : 'paused', trackInfo);
    }
  }
  
  // play button class changes
  function setupPlaybackObserver() {
    const playButton = document.querySelector('.playControls__play');
    if (!playButton) return false;
    
    const observer = new MutationObserver(() => {
      notifyPlaybackStateChange();
    });
    
    observer.observe(playButton, { 
      attributes: true,
      attributeFilter: ['class'] // class flips on play/pause; title or label could work too
    });
    
    return true;
  }
  
  // playback controls: direct clicks
  function monitorPlaybackControls() {
    const playPauseButton = document.querySelector('.playControl');
    if (playPauseButton && !playPauseButton.__monitored) {
      playPauseButton.__monitored = true;
      playPauseButton.addEventListener('click', () => {
        console.debug('Play/pause button');
        // short delay so class can update
        setTimeout(notifyPlaybackStateChange, 50);
      });
    }
    
    // prev/next also affect playback
    const prevButton = document.querySelector('.skipControl__previous');
    const nextButton = document.querySelector('.skipControl__next');
    
    if (prevButton && !prevButton.__monitored) {
      prevButton.__monitored = true;
      prevButton.addEventListener('click', () => {
        console.debug('Previous track button clicked');
        currentTrackTitle = '';
        currentTrackAuthor = '';
        currentTrackUrl = '';
        // longer wait for track change
        setTimeout(notifyPlaybackStateChange, 300);
      });
    }
    
    if (nextButton && !nextButton.__monitored) {
      nextButton.__monitored = true;
      nextButton.addEventListener('click', () => {
        console.debug('Next track button clicked');
        currentTrackTitle = '';
        currentTrackAuthor = '';
        currentTrackUrl = '';
        // longer wait for track change
        setTimeout(notifyPlaybackStateChange, 300);
      });
    }

    // like button: update UI mirror instantly
    const likeButton = document.querySelector('.playbackSoundBadge__like');
    if (likeButton && !likeButton.__monitored) {
      likeButton.__monitored = true;
      likeButton.addEventListener('click', () => {
        console.debug('Like button clicked');
        setTimeout(notifyPlaybackStateChange, 50);
      });
    }

    monitorTimelineSeeking();
    monitorWaveformSeeking();
  }

  function monitorWaveformSeeking() {
    const waveformWrapper = document.querySelector('.waveform');
    
    if (waveformWrapper && !waveformWrapper.__waveformMonitored) {
      waveformWrapper.__waveformMonitored = true;
      
      waveformWrapper.addEventListener('click', () => {
        setTimeout(() => {
          const trackInfo = getTrackInfo();
          currentTrackElapsed = trackInfo.elapsed;
          window.soundcloudAPI.sendTrackUpdate(trackInfo, 'waveform-seek');
        }, 100);
      });
      console.debug('Waveform click monitoring attached');
    }
    
    return !!waveformWrapper;
  }

  function monitorTimelineSeeking() {
    const timelineElement = document.querySelector('.playbackTimeline.is-scrubbable.has-sound');
    
    if (timelineElement && !timelineElement.__seekMonitored) {
      timelineElement.__seekMonitored = true;
      
      const timelineObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.attributeName === 'class') {
            const isDragging = timelineElement.classList.contains('is-dragging');
            
            if (!isDragging && timelineElement.__wasDragging) {
              // drag ended: update presence with new position
              console.debug('Seek completed - updating time position');
              setTimeout(() => {
                const trackInfo = getTrackInfo();
                currentTrackElapsed = trackInfo.elapsed;
                window.soundcloudAPI.sendTrackUpdate(trackInfo, 'timeline-seek');
              }, 50);
            }
            
            timelineElement.__wasDragging = isDragging;
          }
        }
      });
      
      timelineObserver.observe(timelineElement, {
        attributes: true,
        attributeFilter: ['class']
      });
      console.debug('Timeline seek monitoring attached');
    }
    
    return !!timelineElement;
  }
  
  // elapsed time changes, catches loops
  function monitorElapsedTime() {
    const elapsedElement = document.querySelector('.playbackTimeline__timePassed span:last-child');
    
    if (elapsedElement) {
      if (elapsedObserver) {
        elapsedObserver.disconnect();
      }
      
      elapsedObserver = new MutationObserver(() => {
        const trackInfo = getTrackInfo();
        
        // update only if track, play state, loop (elapsed reset) or like changed
        const trackChanged = trackInfo.title !== currentTrackTitle ||
                            trackInfo.author !== currentTrackAuthor ||
                            trackInfo.url !== currentTrackUrl;
        const playStateChanged = trackInfo.isPlaying !== isCurrentlyPlaying;
        const likeChanged = trackInfo.isLiked !== isCurrentTrackLiked;
        
        // near start (0-3s) = loop
        const parseTimeToSeconds = (time) => {
          if (!time) return 0;
          const parts = time.split(':').map(p => parseInt(p) || 0);
          let seconds = 0;
          for (const part of parts) {
            seconds = seconds * 60 + part;
          }
          return seconds;
        };
        const elapsedSeconds = parseTimeToSeconds(trackInfo.elapsed);
        const isLoop = elapsedSeconds <= 3;
        
        if (trackChanged || playStateChanged || likeChanged || isLoop) {
          notifyPlaybackStateChange();
        }
      });
      
      // text content changes
      const parentEl = elapsedElement.parentElement;
      if (parentEl) {
        elapsedObserver.observe(parentEl, {
          childList: true,
          characterData: true,
          subtree: true
        });
        console.debug('Monitoring elapsed time parent element');
      } else {
        elapsedObserver.observe(elapsedElement, {
          childList: true,
          characterData: true,
          subtree: true
        });
        console.debug('Monitoring elapsed time element');
      }
      
      return true;
    }
    return false;
  }
  
  function initialize() {
    const playbackObserverSet = setupPlaybackObserver();
    monitorPlaybackControls();
    
    window.__initialStateSent = false;
    notifyPlaybackStateChange();
    
    // watch for elements loaded later
    if (!playbackObserverSet) {
      const documentObserver = new MutationObserver(() => {
        if (!document.querySelector('.playControls__play')) return;
        
        if (setupPlaybackObserver()) {
          monitorPlaybackControls();
          documentObserver.disconnect();
        }
      });
      
      documentObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    
    // elapsed time for loop detection
    monitorElapsedTime();
    
    // re-monitor replaced elements; page mutates constantly, so one rescan per frame
    let rescanQueued = false;
    const bodyObserver = new MutationObserver(() => {
      if (rescanQueued) return;
      rescanQueued = true;
      requestAnimationFrame(() => {
        rescanQueued = false;
        rescanMonitoredElements();
      });
    });

    function rescanMonitoredElements() {
      const elapsedEl = document.querySelector('.playbackTimeline__timePassed span:last-child');
      if (elapsedEl && !elapsedObserver) {
        monitorElapsedTime();
      }
      
      const waveformEl = document.querySelector('.waveform');
      if (waveformEl && !waveformEl.__waveformMonitored) {
        monitorWaveformSeeking();
      }
      
      const timelineEl = document.querySelector('.playbackTimeline.is-scrubbable.has-sound');
      if (timelineEl && !timelineEl.__seekMonitored) {
        monitorTimelineSeeking();
      }
      
      const prevButton = document.querySelector('.skipControl__previous');
      const nextButton = document.querySelector('.skipControl__next');
      if ((prevButton && !prevButton.__monitored) || (nextButton && !nextButton.__monitored)) {
        monitorPlaybackControls();
      }
      
      const playPauseButton = document.querySelector('.playControl');
      if (playPauseButton && !playPauseButton.__monitored) {
        monitorPlaybackControls();
      }

      const likeButton = document.querySelector('.playbackSoundBadge__like');
      if (likeButton && !likeButton.__monitored) {
        monitorPlaybackControls();
      }
    }
    
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  
  // cleanup on unload
  window.addEventListener('beforeunload', () => {
    if (elapsedObserver) {
      elapsedObserver.disconnect();
      elapsedObserver = null;
    }
  });
  
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initialize();
  } else {
    document.addEventListener('DOMContentLoaded', initialize);
  }
})();
`;
