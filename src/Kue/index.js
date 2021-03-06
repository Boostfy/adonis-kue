'use strict'

const kue = require('kue')
const { ioc } = require('@adonisjs/fold')

/**
 * @module Kue
 * @description Interface to the Kue job queue library
 */
class Kue {
  constructor (Logger, Redis, config = {}, jobs = []) {
    this.Redis = Redis
    this.Logger = Logger
    this.jobs = jobs
    this.config = config
    this._instance = null
    this.registeredJobs = []
  }

  /**
   * @returns {*}
   * @public
   */
  get instance () {
    if (!this._instance) {
      const options = {
        jobEvents: false,
        ...(this.config.options || {}),
        redis: {
          createClientFactory: () => {
            const { connection } = this.config
            const client = this.Redis.connection(connection).duplicate()
            return new Proxy(client, {
              get (target, key) {
                if (key === 'getKey') {
                  return function (key) {
                    return `{${this.prefix}}:${key}`
                  }
                }
                return target[key]
              }
            })
          }
        }
      }
      this._instance = kue.createQueue(options)
      this._instance.watchStuckJobs(10000)
    }
    return this._instance
  }

  /**
  * Dispatch a new job.
  * @param  {String} key
  * @param  {Mixed} data       Data to be passed to job
  * @param  {String} priority  Priority of job
  * @param  {Number} attempts  How many times to attempt the job
  * @param  {Boolean} remove   Should completed jobs be removed from kue
  * @returns {Promise}         Kue job instance
  * @public
  */
  dispatch (key, data, { priority = 'normal', attempts = 1, remove = true, jobFn = () => {} } = {}) {
    if (typeof key !== 'string') {
      throw new Error(`Expected job key to be of type string but got <${typeof key}>.`)
    }
    const job = this.instance
      .create(key, data)
      .priority(priority)
      .attempts(attempts)
      .events(false)
      .removeOnComplete(remove)

    // allow custom functions to be called on the job, e.g. backoff
    jobFn(job)

    return new Promise((resolve, reject) => {
      job.save(err => {
        if (err) {
          this.Logger.error('An error has occurred while creating a Kue job.')
          return reject(err)
        }
        return resolve(job)
      })
    })
  }

  /**
   * Start queue to process all jobs defined in start/app.js
   *
   * @public
   */
  listen () {
    this.jobs.forEach(link => {
      const Job = ioc.use(link)

      // Every job must expose a key
      if (!Job.key) {
        throw new Error(`No key found for job: ${link}`)
      }

      // If job concurrency is not set, default to 1
      if (Job.concurrency === undefined) {
        Job.concurrency = 1
      }

      // If job concurrecny is set to an invalid value, throw error
      if (typeof Job.concurrency !== 'number') {
        throw new Error(`Job concurrency value must be a number but instead it is: <${typeof Job.concurrency}>`)
      }

      // Track currently registered jobs in memory
      this.registeredJobs.push(Job)

      // Register job handler
      this.instance.process(Job.key, Job.concurrency, (job, done) => {
        if (!job) {
          console.error('------ NO JOB (from kue) ---------')
          done(null, true)
        }
        const jobInstance = ioc.make(Job)

        // Every job must expose a handle function
        if (!jobInstance.handle) {
          throw new Error(`No handler found for job: ${link}`)
        }
        if (jobInstance.setJob) {
          jobInstance.setJob(job)
        }
        jobInstance.handle(job.data, job)
          .then(result => {
            if (jobInstance.deleteJob) {
              jobInstance.deleteJob(job)
            }
            done(null, result)
          })
          .catch(error => {
            if (jobInstance.deleteJob) {
              jobInstance.deleteJob(job)
            }
            this.Logger.error(`Error processing job. type=${job.type} id=${job.id}`)
            done(error)
          })
      })
    })
    this.Logger.info(`kue worker listening for ${this.registeredJobs.length} job(s)`)
  }
}

module.exports = Kue
