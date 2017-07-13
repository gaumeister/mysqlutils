var _ = require('lodash');
var Promise = require('bluebird');
var moment = require('moment');
var winston = require('winston');

/**
  Class to provide basic SQL persistence operations.
  @param {string} table required db table name
  @param {string} entity required logical entity name (singular form)
  @param {object} opts optional options settings to override defaults, shown below
  @example <caption>Default options</caption>
  {
    plural: 'string (derived from English plural rules)',
    created_timestamp_column: 'created',
    updated_timestamp_column: 'updated',
    version_number_column: 'version',
    log_category: 'db'
  }
  @param {object} pool required mysql db pool reference.
  @param {object} logger optional logger instance.
  @return an object to be used for model persistence.
  @example <caption>Note, internal metadata is stored in the the form</caption>
  [{
    column: 'column name',
    sql_type: 'string'
    is_pk: true|false whether a primary key column,
    is_autoincrement: true|false whether it is an autoincrement id
    is_created_timestamp: true|false,
    is_updated_timestamp: true|false,
    is_version: true|false
  }]
*/
function DbEntity(table, entity, opts, pool, logger){
  LOGGER = logger;
  this.pool = pool;
  this.table = table;
  this.entity = entity;

  if(_.isNil(opts)||_.isNil(opts.plural)){
    if(_.endsWith(entity,'y')){
      this.plural = entity.substr(0, entity.lastIndexOf('y')) + 'ies';
    } else if (_.endsWith(entity,'s')) {
      this.plural = entity.substr(0, entity.lastIndexOf('s')) + 'es';
    } else {
      this.plural = entity + 's';
    }
  } else {
    this.plural = opts.plural;
  }

  this.options = (opts || {
    created_timestamp_column: 'created',
    updated_timestamp_column: 'updated',
    version_number_column: 'version',
    log_category: 'db'
  });

  if(logger && logger.INFO){
    LOGGER = logger;
  } else {
    //wrapper for winston
    LOGGER = winston.loggers.get(this.options.log_category);
    LOGGER = {
      ERROR: function(msg){winston.log("error", msg);},
      WARN:  function(msg){winston.log("warn", msg);},
      INFO:  function(msg){winston.log("info", msg);},
      DEBUG: function(msg){winston.log("debug", msg);},
      TRACE: function(msg){winston.log("silly", msg);},
    };
  }

  this.metadata = null;//initialized to empty.
}//constructor

/**
  Promise-returning function that ensures consistent handling of database calls.
*/
DbEntity.prototype.callDb = function(sql, parms){
  var self = this;
  return new Promise(function(resolve, reject){
    self.pool.query(sql, parms, function(err, results, fields){
      if(err){
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
};

/**
  Initializes the internal metadata for further use.
  This is a promise-returning function that must be used for any internal
  method requiring metadata.
*/
DbEntity.prototype.fetchMetadata = function(){
  var self = this;
  return new Promise(function(resolve, reject){
    if(_.isNil(self.metadata)){
      var sql = "SHOW COLUMNS FROM "+ self.table + ";";

      self.callDb(sql, [])
      .then(function(results){
        LOGGER.TRACE(self.entity +' fetchMetadata raw results:' + JSON.stringify(results,null,2));
        //init the metadata object.
        self.metadata = [];
        _.each(results, function(item){

          var c = {
            column: item.Field,
            sql_type: item.Type,
            pk: item.Key==='PRI',
            nullable: item.Null==='YES',
            default: item.Default,
            autoincrement: item.Extra==='auto_increment'
          };
          c.is_updated_timestamp=!_.isNil(self.options.updated_timestamp_column)&&c.column===self.options.updated_timestamp_column;
          c.is_created_timestamp=!_.isNil(self.options.created_timestamp_column)&&c.column===self.options.created_timestamp_column;
          c.is_updated_version=!_.isNil(self.options.version_number_column)&&c.column===self.options.version_number_column;

          self.metadata.push(c);
        });

        LOGGER.TRACE("Finalized Metadata: "+JSON.stringify(self.metadata,null,2));
        resolve(self.metadata);
      })
      .catch(function(err){
        LOGGER.ERROR(self.entity +' fetchMetadata error. Details: ' + JSON.stringify(err));
        reject(err);
      });

    } else {
      LOGGER.TRACE("(Metadata already loaded)");
      resolve(self.metadata);
    }
  });
};

/**
  Syntactic sugar for selectOne, selecting a single entity by its PK named 'id'.
  @return promise for entity. If not found, the empty object {} will be returned.
*/
DbEntity.prototype.get = function(id){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG(self.entity +' get...');
    var entity = {};

    self.fetchMetadata()
    .then(function(){
      var sql = "SELECT * FROM "+ self.table + " WHERE id = ?";
      LOGGER.DEBUG('  query sql: ' + sql);
      return self.callDb(sql, [id]);
    })
    .then(function(results){
      LOGGER.TRACE(self.entity +' get results:' + JSON.stringify(results));
      if(results.length>0){
        entity = results[0];
      }
      resolve(entity);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' get error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};

/**
  Select all (up to 1000) of a kind of entity.
  @return promise for entity.
  @param opts options to cover orderBy and limit options
  @example
  {
    orderBy: ['+column_name','-column_name'],
    limit: 1000,
    offset: 2500
  }
  @return Promise for an array of objects. If not found, the empty array [] will be returned.
*/
DbEntity.prototype.all = function(opts){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG(self.entity +' all...');
    var rs = [];
    self.fetchMetadata()
    .then(function(){
      var sql = "SELECT * FROM "+ self.table + " ";

      sql = self._appendOrderByAndLimit(sql, opts);

      LOGGER.DEBUG('  query sql: ' + sql);

      return self.callDb(sql, []);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' all results:' + JSON.stringify(results));
      rs = results;
      resolve(rs);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' all error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};

/**
  Performs a query for all rows matching the given template object.
  @param query 'template' object that is used to match the query.

  All attributes provided on the query object (including those assigned a null
  value) are assumed to be 'ANDed' together.

  If you wish an 'OR' instead, add an opts.booleanMode : 'OR'
  @param opts {object} query options
  @example
  {
    orderBy: ['+column_name','-column_name'],
    limit: 1000,
    offset: 2500,
    booleanMode: 'OR'
  }
*/
DbEntity.prototype.find = function(query, opts){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG(self.entity +' find...');

    self.fetchMetadata()
    .then(function(){
      var sql = "SELECT * FROM "+ self.table + " ";
      var parms = [];
      var bool = ' AND ';
      if(!_.isNil(opts) && !_.isNil(opts.booleanMode)){
        bool=' '+opts.booleanMode+' ';
      }
      sql+=' WHERE ';
      var where = '';
      _.each(query, function(v, k){
        if(where!=='') where+=bool;
        where += k+'=?';

        parms.push(v);
      });
      sql+=where;

      sql = self._appendOrderByAndLimit(sql, opts);

      LOGGER.DEBUG('  query sql: ' + sql);
      LOGGER.DEBUG('  query parms: ' + JSON.stringify(parms));
      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' find results:' + JSON.stringify(results));
      resolve(results);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' find error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};//find

/**
  Same as find, except it returns one row or an empty object if
  nothing is found.
  @param opts {object} query options (not particularly relevant for this function, but available)
  @example
  {
    orderBy: ['+column_name','-column_name'],
    limit: 1000,
    offset: 2500,
    booleanMode: 'OR'
  }
*/
DbEntity.prototype.one = function(query, opts){
  var self = this;
  return new Promise(function(resolve, reject){
    var entity = {};
    return self.find(query,opts)
    .then(function(result){
     if(result.length>0){
       entity = result[0];
     }
     resolve(entity);
    })
    .catch(function(err){
     reject(err);
    });
  });

};//one

/**
  Typically used for complex queries or reporting, this function performs a
  traditional generic sql query selecting anything matching the given WHERE clause
  (do not include the word 'WHERE') and parameters. To avoid SQL injection
  risks, take care to only use this function when user input CANNOT
  affect the WHERE clause being built. It is highly recommended to use
  parameterized SQL.
  @param where {string} parameterized where clause without the 'WHERE'
  @param parms {array} individual data parameters for substitution into the WHERE clause
  @param opts {object} query options (not particularly relevant for this function, but available)
  @example
  {
    orderBy: ['+column_name','-column_name'],
    limit: 1000,
    offset: 2500,
    booleanMode: 'OR'
  }
*/
DbEntity.prototype.selectWhere = function(where, parms, opts){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG(self.entity +' selectWhere...');
    var rs = [];
    self.fetchMetadata()
    .then(function(){
      var sql = "SELECT * FROM "+ self.table + " ";

      sql+=' WHERE ';

      sql+=where;

      sql = self._appendOrderByAndLimit(sql, opts);

      LOGGER.DEBUG('  query sql: ' + sql);
      LOGGER.DEBUG('  query parms: ' + JSON.stringify(parms));
      return self.callDb(sql, []);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' selectWhere results:' + JSON.stringify(results));
      rs = results;
      resolve(rs);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' selectWhere error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};//selectWhere

/**
  Creates a single entity.
  @param save object to save.
  @return a promise bearing the save object. It will have its autogenerated key
  field set if one was detected.
*/
DbEntity.prototype.create = function(save, opts){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG( self.entity + ' create...' );
    self.fetchMetadata()
    .then(function(){
      var parms = [];
      var cols = '';
      var vals = '';
      var not_ai_pks = _.filter(self.metadata,function(col){
        return (col.pk===true && col.autoincrement===false )||(col.pk===false);
      });
      //LOGGER.DEBUG(JSON.stringify(not_ai_pks, null, 1));
      for(var i=0; i<not_ai_pks.length; i++){
        var col=not_ai_pks[i];
        if(cols!=='') cols+=', ';
        cols+=col.column;

        if(vals!=='') vals+=', ';
        if (self.options && col.column===self.options.created_timestamp_column){
          vals+='CURRENT_TIMESTAMP';
        } else if (self.options && col.column===self.options.updated_timestamp_column){
          vals+='CURRENT_TIMESTAMP';
        } else if (self.options && col.column===self.options.version_number_column){
          vals+='0';
        } else {
          vals+='?';
          parms.push(_transformToSafeValue(save[col.column], col));
        }
      };
      var sql = "INSERT INTO " + self.table + " ("+ cols +") VALUES (" + vals + ");";


      LOGGER.DEBUG('  create sql: ' + sql);
      LOGGER.DEBUG('  create parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.TRACE('  create raw results: ' + JSON.stringify(results));
      //Put the autogenerated id on the entity and return it.
      if(results.affectedRows > 0 && !_.isNil(results.insertId) && results.insertId > 0){
        //console.log('----- id ' + results.insertId)
        var keyCol = _.find(self.metadata, {autoincrement: true, pk: true});
        if(!_.isNil(keyCol)){
          save[keyCol.column] = results.insertId;
        }
        //console.log('----- keycol ' + JSON.stringify(keyCol));

      }
      LOGGER.DEBUG(self.entity +' create results:' + JSON.stringify(results));
      resolve(save);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' create error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};

/**
  Updates a single row by id.
  @param object to save.
  @return a promise bearing the save object. An _affectedRows attribute will
  be added to this object. Any defaults in the database will
  NOT be included in the returned object, and you should retrieve the object
  again to update their values if you need them.
*/
DbEntity.prototype.update = function(save, opts){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG( self.entity + ' update...' );

    self.fetchMetadata().then(function(){
      var parms = [];
      var sql = "UPDATE " + self.table + " SET ";
      var not_pks = _.filter(self.metadata,function(col){ return col.pk===false; });
      var sets = '';

      _.each(save, function(v,k){
        //Exists on not_pks?
        var col = _.find(not_pks, {column: k});
        if(!_.isNil(col)){
          if (self.options && col.column===self.options.created_timestamp_column){
            //not part of sql
          } else {
            if(sets!=='') sets+=', ';
            var needParm = false;
            if(self.options && col.column===self.options.version_number_column){
              sets+=self.options.version_number_column+'='+self.options.version_number_column+'+1';
            } else if (self.options && col.column===self.options.updated_timestamp_column){
              sets+=col.column+'=CURRENT_TIMESTAMP'
            } else {
              needParm = true;
              sets+=col.column+'=?';
            }

            if(needParm){
              var parmVal = _transformToSafeValue(v, col);
              if(_.isNil(parmVal)){
                parmVal = null;
              }
              parms.push(parmVal);
            }
          }
        }
      });

      sql+=sets;
      sql+=' WHERE ';
      var pks = _.filter(self.metadata,{ pk: true })
      var where = '';
      _.each(pks, function(col){
        if(where!=='') where+=' AND ';
        where+=col.column+'=?';

        var parmVal = save[col.column];
        parms.push(parmVal);
      });
      sql+=where;

      LOGGER.DEBUG('  update sql: ' + sql);
      LOGGER.DEBUG('  update parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      save._affectedRows = results.affectedRows;
      LOGGER.DEBUG(self.entity +' update results:' + JSON.stringify(results));
      resolve(save);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' update error. Details: \n' + JSON.stringify(err));
      reject(err);
    });

  });
};

/**
  Deletes a single entity by its primary key..
  @param toDelete object whose attributes
  @return a promise bearing the incoming object with an _affectedRows attribute added.
*/
DbEntity.prototype.deleteOne = function(toDelete){
  var self = this;
  return new Promise(function(resolve, reject){

    LOGGER.DEBUG( self.entity + ' delete...' );

    self.fetchMetadata()
    .then(function(){
      var parms = [];
      var sql = "DELETE FROM " + self.table;
      sql+=' WHERE ';
      var pks = _.filter(self.metadata,{ pk: true })
      var where = '';
      _.each(pks, function(col){
        if(where!=='') where+=' AND ';
        where+=col.column+'=?';

        var parmVal = toDelete[col.column];
        parms.push(parmVal);
      });
      sql+=where;

      LOGGER.DEBUG('  deleteOne sql: ' + sql);
      LOGGER.DEBUG('  deleteOne parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' deleteOne results:' + JSON.stringify(results));
      toDelete._affectedRows = results.affectedRows;
      resolve(toDelete);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' deleteOne error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};

/**
* Deletes a single entity by its PK named 'id'.
* @return a promise bearing an object with an _affectedRows property.
*/
DbEntity.prototype.delete = function(id){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG( self.entity + ' delete...' );
    var entity = {};
    self.fetchMetadata().then(function(){
      var parms = [id];
      var sql = "DELETE FROM " + self.table;
      sql+=' WHERE id = ?';

      LOGGER.DEBUG('  delete sql: ' + sql);
      LOGGER.DEBUG('  delete parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' delete results:' + JSON.stringify(results));
      entity = {_affectedRows: results.affectedRows};
      resolve(entity);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' delete error. Details:\n' + JSON.stringify(err));
      reject(err);
    });
  });
};

/**
  Deletes entities that match all the given attributes on the criteria object.
  @param criteria object whose attributes specify the conditions for deletion.
  @return a promise bearing the incoming object with an _affectedRows attribute added.
*/
DbEntity.prototype.deleteMatching = function(criteria){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG( self.entity + ' delete...' );

    self.fetchMetadata().then(function(){
      var parms = [];
      var bool = ' AND ';
      sql+=' WHERE ';
      var where = '';
      _.each(criteria, function(v, k){
        if(where!=='') where+=bool;
        where += k+'=?';

        parms.push(v);
      });
      sql+=where;

      LOGGER.DEBUG('  deleteMatching sql: ' + sql);
      LOGGER.DEBUG('  deleteMatching parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' deleteMatching results:' + JSON.stringify(results));
      criteria._affectedRows = results.affectedRows;
      resolve(criteria);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' deleteMatching error. Details:\n' + JSON.stringify(err));
      reject(err.code);
    });
  });
};

/**
  Deletes any entity matching the given WHERE clause (do not include the word 'WHERE')
  and parameters. To avoid SQL injection risks, take care to only use this
  function when user input CANNOT affect the WHERE clause being built. It is
  highly recommended to use parameterized SQL.
  @param where where clause without the 'WHERE'
  @param parms parameters for the WHERE clause.
  @return a promise bearing the a simple object with an _affectedRows attribute.
*/
DbEntity.prototype.deleteWhere = function(where, parms){
  var self = this;
  return new Promise(function(resolve, reject){
    LOGGER.DEBUG( self.entity + ' deleteWhere...' );
    var ret = {};
    self.fetchMetadata()
    .then(function(){
      var sql = "DELETE FROM " + self.table;
      sql+=' WHERE ';
      sql+=where;

      LOGGER.DEBUG('  deleteWhere sql: ' + sql);
      LOGGER.DEBUG('  deleteWhere parameters: ' + JSON.stringify(parms));

      return self.callDb(sql, parms);
    })
    .then(function(results){
      LOGGER.DEBUG(self.entity +' deleteWhere results:' + JSON.stringify(results));
      ret = { _affectedRows : results.affectedRows };
      resolve(ret);
    })
    .catch(function(err){
      LOGGER.ERROR(self.entity +' deleteWhere error. Details:\n' + JSON.stringify(err));
      reject(err.code);
    });
  });
};

/**
  Appends the ORDER BY and LIMIT options to a sql statement.
  @param opts options to cover orderBy, limit, and offset options.
  orderBy is an array of column names. Each column name should be immediately
  preceded by + to indicate ascending order, or a - indicating descending order.
  If orderBy is not given explicitly, the results will be returned in ASC order of
  the primary key.
  limit (optional) is the number of rows to be returned. If unspecified, the
  resultset will be limited to 1000 rows.
  offset (optional) is the number of rows to skip from the beginning of the potential
  row resultset if otherwise unlimited. If offset is omitted, the results will
  be taken from the beginning of the resultset.
  @example
  {
    orderBy: ['+column_name','-column_name'],
    limit: 1000,
    offset: 2500
  }
*/
DbEntity.prototype._appendOrderByAndLimit = function(sql, opts){
  var self= this;
  var orderBy = '';
  var limit = '';

  if(!_.isNil(opts)){
    if(!_.isNil(opts.orderBy) && opts.orderBy.length > 0){
      orderBy+=' ORDER BY '
      for(var i=0; i<opts.orderBy.length; i++){
        if(i>0) orderBy+=', '
        var colname = opts.orderBy[i];
        var ord = 'ASC';
        if (_.startsWith(colname, '-')){
          colname = colname.substr(1);
          ord = 'DESC';
        } else if(_.startsWith(colname, '+')) {
          colname = colname.substr(1);
        }
        orderBy+=colname + ' ' + ord;
      }
    }
    if(!_.isNil(opts.limit)){
      limit+=' LIMIT ' + opts.limit;
    } else {
      limit+=' LIMIT 1000'
    }

    if(!_.isNil(opts.offset)){
      limit+=' OFFSET ' + opts.offset;
    }
  }
  if(orderBy === ''){
    sql+=' ORDER BY ';

    var pks = _.filter(self.metadata, {pk: true});
    for(var i=0; i<pks.length; i++){
      if(i>0) orderBy+=', '
      sql+=pks[i].column + ' ASC';
    }
  }
  sql+=orderBy;
  sql+=limit;

  return sql;
}

/**
  Helper that transforms input values to acceptable defaults for database columns.
*/
function _transformToSafeValue(input, column){
  var out = input;
  var datatype = column.sql_type;
  var nullable = column.nullable;
  if( input === '' ){
    //empty string.
    if(datatype==='datetime'|| datatype==='timestamp' ||_.startsWith(datatype, 'int') || _.startsWith(datatype, 'num') || _.startsWith(datatype, 'dec')){
      if(nullable){
        out = null;
      } else {
        throw new Error(column.column + ' is not permitted to be empty.')
      }
    }

  } else if( !_.isNil(input) ) {
    //not null, not undefined
    if(datatype==='datetime'|| datatype==='timestamp'){
      out = moment(input).format('YYYY-MM-DD HH:mm:ss');
    }
  }
  return out;
}

module.exports=DbEntity;
