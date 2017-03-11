'use strict';
var uuid, Service, Characteristic, StreamController;

var fs = require('fs');
var ip = require('ip');
var spawn = require('child_process').spawn;

module.exports = {
  FFMPEG: FFMPEG
};

function FFMPEG(hap, ffmpegOpt) {
  uuid = hap.uuid;
  Service = hap.Service;
  Characteristic = hap.Characteristic;
  StreamController = hap.StreamController;

  if (!ffmpegOpt.source) {
    throw new Error("Missing source for camera.");
  }

  this.ffmpegSource = ffmpegOpt.source;

  this.services = [];
  this.streamControllers = [];

  this.pendingSessions = {};
  this.ongoingSessions = {};

  var numberOfStreams = ffmpegOpt.maxStreams || 2;
  var videoResolutions = [];
  
  var maxWidth = ffmpegOpt.maxWidth;
  var maxHeight = ffmpegOpt.maxHeight;
  var maxFPS = (ffmpegOpt.maxFPS > 30) ? 30 : ffmpegOpt.maxFPS;

  if (maxWidth <= 320) {
    if (maxHeight <= 240) {
      videoResolutions.push([320, 240, maxFPS]);
      if (maxFPS > 15) {
        videoResolutions.push([320, 240, 15]);
      }
    }

    if (maxHeight <= 180) {
      videoResolutions.push([320, 180, maxFPS]);
      if (maxFPS > 15) {
        videoResolutions.push([320, 180, 15]);
      }
    }
  }

  if (maxWidth <= 480) {
    if (maxHeight <= 360) {
      videoResolutions.push([480, 360, maxFPS]);
    }

    if (maxHeight <= 270) {
      videoResolutions.push([480, 270, maxFPS]);
    }
  }

  if (maxWidth <= 640) {
    if (maxHeight <= 480) {
      videoResolutions.push([640, 480, maxFPS]);
    }

    if (maxHeight <= 360) {
      videoResolutions.push([640, 360, maxFPS]);
    }
  }

  if (maxWidth <= 1280) {
    if (maxHeight <= 960) {
      videoResolutions.push([1280, 960, maxFPS]);
    }

    if (maxHeight <= 720) {
      videoResolutions.push([1280, 720, maxFPS]);
    }
  }

  if (maxWidth <= 1920) {
    if (maxHeight <= 1080) {
      videoResolutions.push([1920, 1080, maxFPS]);
    }
  }

  let options = {
    proxy: false, // Requires RTP/RTCP MUX Proxy
    srtp: true, // Supports SRTP AES_CM_128_HMAC_SHA1_80 encryption
    video: {
      resolutions: videoResolutions,
      codec: {
        profiles: [2], // Enum, please refer StreamController.VideoCodecParamProfileIDTypes
        levels: [2] // Enum, please refer StreamController.VideoCodecParamLevelTypes
      }
    },
    audio: {
      codecs: [
        {
          type: "OPUS", // Audio Codec
          samplerate: 24 // 8, 16, 24 KHz
        }
      ]
    }
  }

  this.createCameraControlService();
  this._createStreamControllers(numberOfStreams, options); 
}

FFMPEG.prototype.handleCloseConnection = function(connectionID) {
  this.streamControllers.forEach(function(controller) {
    controller.handleCloseConnection(connectionID);
  });
}

FFMPEG.prototype.handleSnapshotRequest = function(request, callback) {
  let resolution = request.width + 'x' + request.height;
  let ffmpeg = spawn('ffmpeg', (this.ffmpegSource + ' -t 1 -s '+ resolution + ' -f image2 -').split(' '), {env: process.env});
  var imageBuffer = Buffer(0);

  ffmpeg.stdout.on('data', function(data) {
    imageBuffer = Buffer.concat([imageBuffer, data]);
  });
  ffmpeg.on('close', function(code) {
    callback(undefined, imageBuffer);
  });
}

FFMPEG.prototype.prepareStream = function(request, callback) {
  var sessionInfo = {};

  let sessionID = request["sessionID"];
  let targetAddress = request["targetAddress"];

  sessionInfo["address"] = targetAddress;

  var response = {};

  let videoInfo = request["video"];
  if (videoInfo) {
    let targetPort = videoInfo["port"];
    let srtp_key = videoInfo["srtp_key"];
    let srtp_salt = videoInfo["srtp_salt"];

    let videoResp = {
      port: targetPort,
      ssrc: 1,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["video"] = videoResp;

    sessionInfo["video_port"] = targetPort;
    sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["video_ssrc"] = 1; 
  }

  let audioInfo = request["audio"];
  if (audioInfo) {
    let targetPort = audioInfo["port"];
    let srtp_key = audioInfo["srtp_key"];
    let srtp_salt = audioInfo["srtp_salt"];

    let audioResp = {
      port: targetPort,
      ssrc: 2,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["audio"] = audioResp;

    sessionInfo["audio_port"] = targetPort;
    sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["audio_ssrc"] = 2; 
  }

  let currentAddress = ip.address();
  var addressResp = {
    address: currentAddress
  };

  if (ip.isV4Format(currentAddress)) {
    addressResp["type"] = "v4";
  } else {
    addressResp["type"] = "v6";
  }

  response["address"] = addressResp;
  this.pendingSessions[uuid.unparse(sessionID)] = sessionInfo;

  callback(response);
}

FFMPEG.prototype.handleStreamRequest = function(request) {
  var sessionID = request["sessionID"];
  var requestType = request["type"];
  if (sessionID) {
    let sessionIdentifier = uuid.unparse(sessionID);

    if (requestType == "start") {
      var sessionInfo = this.pendingSessions[sessionIdentifier];
      if (sessionInfo) {
        var width = 1280;
        var height = 720;
        var fps = 30;
        var bitrate = 300;

        let videoInfo = request["video"];
        if (videoInfo) {
          width = videoInfo["width"];
          height = videoInfo["height"];

          let expectedFPS = videoInfo["fps"];
          if (expectedFPS < fps) {
            fps = expectedFPS;
          }

          bitrate = videoInfo["max_bit_rate"];
        }

        let targetAddress = sessionInfo["address"];
        let targetVideoPort = sessionInfo["video_port"];
        let videoKey = sessionInfo["video_srtp"];
        
        let audioInfo = request["audio"];
        let targetAudioPort = sessionInfo["audio_port"];
        let audioKey = sessionInfo["audio_srtp"];
        audioInfo["max_bit_rate"] = 64;
        let frameduration = audioInfo["packet_time"];
        let ffmpegCommand = this.ffmpegSource + ' -map 0:v -codec:v libx264 -x264opts colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off:analyse=0x3,0x133 -movflags +faststart -an -framerate ' + fps + ' -pix_fmt yuv420p -tune zerolatency -vf scale=w='+ width +':h='+ height +' -b:v '+ bitrate +'k -bufsize '+ bitrate +'k -strict experimental -flags +loop -i_qfactor 0.71 -rc_eq "blurCplx^(1-qComp)" -qcomp 0.6 -qmin 10 -qmax 51 -coder 0 -partitions parti4x4+partp8x8+partb8x8 -subq 5 -threads 5 -payload_type 99 -ssrc 1 -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params '+videoKey.toString('base64')+' -rtsp_transport tcp -max_delay 500000 srtp://'+targetAddress+':'+targetVideoPort+'?&rtcpport='+targetVideoPort+'&pkt_size=1378';
         ffmpegCommand += ' -map 0:a -vn -f u16le -c:a pcm_s16le -ac 1 -af aresample=24000 -codec:a libopus -b:a 64k -application lowdelay -frame_duration ' + frameduration + ' -compression_level 10 -dtx 1 -strict 2 -payload_type 110 -ssrc 2 -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params '+audioKey.toString('base64')+' -rtsp_transport tcp -max_delay 500000 srtp://'+targetAddress+':'+targetAudioPort+'rtcpport='+targetAudioPort;

         console.log(ffmpegCommand);
        let ffmpeg = spawn('ffmpeg', ffmpegCommand.split(' '), {env: process.env});
        this.ongoingSessions[sessionIdentifier] = ffmpeg;
      }

      delete this.pendingSessions[sessionIdentifier];
    } else if (requestType == "stop") {
      var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }

      delete this.ongoingSessions[sessionIdentifier];
    }
  }
}

FFMPEG.prototype.createCameraControlService = function() {
  var controlService = new Service.CameraControl();

  this.services.push(controlService);
}

// Private

FFMPEG.prototype._createStreamControllers = function(maxStreams, options) {
  let self = this;

  for (var i = 0; i < maxStreams; i++) {
    var streamController = new StreamController(i, options, self);

    self.services.push(streamController.service);
    self.streamControllers.push(streamController);
  }
}
