'use client'

import { format } from 'date-fns';
import React, { useState, useEffect } from 'react';
import SongBanner from './components/SongBanner';


const Home = () => {
  //const domain = 'https://suno.blauker.com';
  const domain = 'http://localhost:3000';
  const [songName, setSongName] = useState("");
  const [songTags, setSongTags] = useState("");
  const [songDate, setSongDate] = useState("");
  const [songLink, setSongLink] = useState("");
  const [songImageSrc, setSongImageSrc] = useState("");
  const [showBanner, setShowBanner] = useState(false);
  const [songUrl, setSongUrl] = useState('');

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSongUrl(event.target.value);
  };

  function FindSong() {
    setShowBanner(false);

    if (songUrl.startsWith('https://app.suno.ai/song/')) {
      var songId = songUrl.replace("https://app.suno.ai/song/", "");
      if (songId.endsWith('/')) songId = songId.replace('/', '');

      fetch(domain + "/api/get?ids=" + songId)
        .then(response => response.json())
        .then(data => {
          var songData = data[0];

          const date = new Date(songData.created_at);
          const formattedDate = format(date, "MMMM d',' yyyy");

          setSongImageSrc(songData.image_url);
          setSongName(songData.title);
          setSongTags(songData.tags);
          setSongDate(formattedDate);
          setSongLink(songData.audio_url);

          setShowBanner(true);
        })
        .catch(error => console.error('Error:', error));
    }
  }

  function DownloadSong()
  {
    if (songLink != "")
    {
      fetch(songLink)
        .then(response => response.blob())
        .then(blob => {
          const url = window.URL.createObjectURL(blob);

          const link = document.createElement('a');
          link.href = url;
          link.download = `${songName}.mp3`;
          link.click();
          window.URL.revokeObjectURL(url);
        })
        .catch(error => console.error('Error al descargar el archivo:', error));
    }
  }

  return (
    <>
      <div className="App">
        <div className='h1'>Download Suno AI songs free!</div>
        <div className=''>Easy way to download any Suno song</div>

        <div className='search-song'>
          <input
            type="text"
            id="songName"
            name="songName"
            className="song-input"
            placeholder="Paste suno url song here"
            value={songUrl}
            onChange={handleChange}
          />
          <button className="song-button" onClick={FindSong}>Find Suno Song</button>
        </div>

        {showBanner ? (
          <SongBanner
            sName={songName}
            sTags={songTags}
            sDate={songDate}
            iSrc={songImageSrc}
            onDownloadSong={DownloadSong}
          />
        ) : null}

        <div className='howto'>
          <u className='h2'>How to get song url?</u> <br />
          <p>1-. Find a song you want to download, and click on <b>"share"</b> button. </p>
          <p>2-. Click on <b>"Copy Song Link"</b>. </p>
          <p>3-. Paste the Link on the <b>browser</b> and click <b>"Find Suno Song"</b>.</p>
          <p>4-. If the song and link are available, the song frame will be displayed. </p>
          <p>5-. Click on <b>"Download Song"</b>.</p>
          <img className='resizable-img' src='/images/step1.PNG' alt='' /> <br /><br /><br /><br />
        </div>

        <footer>
          This is a simple web to download any <a href='https://app.suno.ai/'>Suno</a> song. <br />
          Created by <a href='https://blauker.com'>Blauker</a>, used: <a href='https://suno-api.vercel.app/'>Suno API (UNOFFICIAL)</a>
        </footer>
      </div>
    </>
  );
}

export default Home;
