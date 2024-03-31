import React from 'react';

interface SongProps {
  sName: string;
  sTags: string;
  sDate: string;
  iSrc: string;
  onDownloadSong: () => void
}

const SongBanner: React.FC<SongProps> = ({ sName, sTags, sDate, iSrc, onDownloadSong }) => {
  return (
    <div className='song-data' id='songData'>
      <div className='song-banner'>
        <img id="sImg" className="song-image" alt="Song Image" decoding="async" src={iSrc} />
      </div>
      <div className='song-info'>
        <div className='name'>{sName}</div>
        <p className='tags'>{sTags}</p>
        <div className='date'>{sDate}</div>
      </div>

      <button className='dwButton' onClick={onDownloadSong}>Download Song</button>
      <span className='song-banner-bg'></span>
      <span className='song-banner-bg2'></span>
    </div>
  );
}

export default SongBanner;