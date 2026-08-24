import assert from 'node:assert/strict';
import '../portal.js';

const portal = globalThis.Media26Portal;

const model = portal.xtreamApiToModel(
  'http://playshare.co:8080',
  'porta290694',
  'boiling6department',
  {
    liveCategories: [{ category_id: '7', category_name: 'Punjabi' }],
    vodCategories: [{ category_id: '22', category_name: 'Movies' }],
    seriesCategories: [{ category_id: '33', category_name: 'Shows' }],
    liveStreams: [{
      stream_id: 171,
      name: 'PB: PTC PUNJABI',
      stream_icon: 'ptc.png',
      category_id: '7',
      epg_channel_id: 'ptcpunjabi.in'
    }],
    vodStreams: [{
      stream_id: 99,
      name: 'Sample Movie',
      stream_icon: 'movie.png',
      category_id: '22',
      container_extension: 'mp4'
    }],
    series: [{
      series_id: 123,
      name: 'Sample Show',
      cover: 'show.png',
      category_id: '33',
      plot: 'A show'
    }]
  }
);

assert.equal(model.total, 3);
assert.deepEqual(model.liveCats, [{ category_id: 'xtl7', category_name: 'Punjabi' }]);
assert.equal(model.live[0].direct_source, 'http://playshare.co:8080/live/porta290694/boiling6department/171.ts');
assert.equal(model.live[0].container_extension, 'ts');
assert.equal(model.live[0].epg_channel_id, 'ptcpunjabi.in');
assert.equal(model.vod[0].direct_source, 'http://playshare.co:8080/movie/porta290694/boiling6department/99.mp4');
assert.equal(model.series[0]._xtreamSeriesId, 123);
assert.equal(model.series[0].category_id, 'xts33');

const reportedServerModel = portal.xtreamApiToModel(
  'http://seller.example:8080',
  'user1',
  'pass1',
  {
    serverInfo: { server_protocol: 'http', url: 'stream.example', port: '80' },
    liveStreams: [{ stream_id: 5, name: 'Reported Server Channel' }]
  }
);

assert.equal(
  reportedServerModel.live[0].direct_source,
  'http://stream.example/live/user1/pass1/5.ts',
  'Xtream API streams should use server_info when the panel reports a different stream host/port'
);
